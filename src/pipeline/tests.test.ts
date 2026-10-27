import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import {
  TestParseError,
  emptySummary,
  parseJUnit,
  parseTap,
  parseTests,
  parseXUnit,
  type TestFormat,
} from './tests.js'

const JUNIT_NESTED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="all" tests="99" failures="99">
  <testsuite name="outer">
    <testcase name="passes" classname="app.Outer" time="0.1"/>
    <testsuite name="inner">
      <testsuite name="deepest">
        <testcase name="deep pass" classname="app.Deep"/>
        <testcase name="deep fail" classname="app.Deep">
          <failure message="expected 1 to equal 2" type="AssertionError">stack trace here</failure>
        </testcase>
      </testsuite>
      <testcase name="text failure" classname="app.Inner">
        <failure type="AssertionError"><![CDATA[  boom &amp; <bust>  ]]></failure>
      </testcase>
      <testcase name="errors out" classname="app.Inner">
        <error message="TypeError: x is undefined">at foo.js:1</error>
      </testcase>
      <testcase name="later" classname="app.Inner"><skipped/></testcase>
      <testcase name="skipped with reason" classname="app.Inner">
        <skipped message="not on CI"/>
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>
`

const JUNIT_SINGLE = `<testsuite name="Solo" tests="2">
  <testcase name="no class"><failure>plain &lt;text&gt;&#10;message</failure></testcase>
  <testcase name="ok" classname="Solo.Case"></testcase>
</testsuite>`

const XUNIT = `<?xml version="1.0" encoding="utf-8"?>
<assemblies timestamp="10/20/2026 12:00:00">
  <assembly name="/build/Tests.dll" total="4" passed="1" failed="1" skipped="1">
    <collection name="Test collection for Ns.MathTests" total="3">
      <test name="Ns.MathTests.Adds" type="Ns.MathTests" method="Adds" time="0.01" result="Pass"/>
      <test name="Ns.MathTests.Divides" type="Ns.MathTests" method="Divides" time="0.02" result="Fail">
        <failure exception-type="Xunit.Sdk.EqualException">
          <message><![CDATA[Assert.Equal() Failure
Expected: 2
Actual:   3]]></message>
          <stack-trace><![CDATA[   at Ns.MathTests.Divides() in MathTests.cs:line 12]]></stack-trace>
        </failure>
      </test>
      <test name="Ns.MathTests.Later" type="Ns.MathTests" method="Later" time="0" result="Skip">
        <reason><![CDATA[Not yet]]></reason>
      </test>
    </collection>
    <collection name="Test collection for Ns.Other">
      <test name="Ns.Other.Only" type="Ns.Other" method="Only" result="Pass"/>
    </collection>
    <errors>
      <error type="test-collection-cleanup" name="Test collection for Ns.Other">
        <failure exception-type="System.InvalidOperationException"><message>cleanup failed</message></failure>
      </error>
    </errors>
  </assembly>
</assemblies>`

describe('Test result parsing', () => {
  it('U12.9 counts JUnit testcases across nested suites', () => {
    const summary = parseJUnit(JUNIT_NESTED)
    assert.deepEqual(summary, {
      passed: 2,
      failed: 3,
      skipped: 2,
      failures: [
        { name: 'app.Deep › deep fail', message: 'expected 1 to equal 2' },
        { name: 'app.Inner › text failure', message: 'boom &amp; <bust>' },
        {
          name: 'app.Inner › errors out',
          message: 'TypeError: x is undefined',
        },
      ],
    })
  })

  it('U12.9 reads a single testsuite root and classname-less testcases', () => {
    assert.deepEqual(parseJUnit(JUNIT_SINGLE), {
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: [{ name: 'Solo › no class', message: 'plain <text>\nmessage' }],
    })
  })

  it('U12.9 names a suiteless, classless testcase by its name alone', () => {
    const summary = parseJUnit(
      '<testsuites><testcase name="bare"><error/></testcase></testsuites>',
    )
    assert.deepEqual(summary.failures, [{ name: 'bare', message: '' }])
    assert.deepEqual(parseJUnit('<testsuites/>'), emptySummary())
  })

  it('U12.9 clips long failure messages to 2000 characters', () => {
    const long = 'x'.repeat(5000)
    const summary = parseJUnit(
      `<testsuite name="s"><testcase name="t"><failure message="${long}"/></testcase></testsuite>`,
    )
    assert.equal(summary.failures[0]?.message.length, 2000)
  })

  it('U12.9 reads xUnit.net v2 results', () => {
    assert.deepEqual(parseXUnit(XUNIT), {
      passed: 2,
      failed: 2,
      skipped: 1,
      failures: [
        {
          name: 'Ns.MathTests.Divides',
          message: 'Assert.Equal() Failure\nExpected: 2\nActual:   3',
        },
        { name: 'Test collection for Ns.Other', message: 'cleanup failed' },
      ],
    })
  })

  it('U12.9 reads an xUnit assembly root and falls back for messages', () => {
    const summary = parseXUnit(`<assembly name="a.dll"><collection name="c">
      <test name="A.B.C" result="Fail"><failure exception-type="Boom"/></test>
      <test name="A.B.D" result="Fail"/>
      <test name="A.B.E" result="NotRun"/>
    </collection></assembly>`)
    assert.deepEqual(summary, {
      passed: 0,
      failed: 2,
      skipped: 1,
      failures: [
        { name: 'A.B.C', message: 'Boom' },
        { name: 'A.B.D', message: '' },
      ],
    })
  })

  it('U12.9 reads TAP results, directives, YAML diagnostics and the plan', () => {
    const summary = parseTap(`TAP version 14
1..9
ok 1 - first
not ok 2 - second
  ---
  message: "expected \\"a\\" to be \\"b\\""
  severity: fail
  ...
ok 3 - skipped one # SKIP no network
not ok 4 - unfinished # todo later
ok 5 - quirky # Skipped: platform
# Subtest: nested
    not ok 1 - inner failure is not counted
    1..1
not ok 6 - nested
not ok 7 - no message field
  ---
  found: 3
  wanted: 4
  ...
not ok 8 - block message
  ---
  message: |
    line one
    line two
  at: file.js:3
  ...
not ok 9 - has \\# hash in name
  ---
  message: 'it''s broken'
  ...
`)
    assert.deepEqual(summary, {
      passed: 1,
      failed: 5,
      skipped: 3,
      failures: [
        { name: 'second', message: 'expected "a" to be "b"' },
        { name: 'nested', message: '' },
        { name: 'no message field', message: 'found: 3\nwanted: 4' },
        { name: 'block message', message: 'line one\nline two' },
        { name: 'has # hash in name', message: "it's broken" },
      ],
    })
  })

  it('U12.9 reports TAP tests missing from the plan', () => {
    const summary = parseTap(
      String.fromCharCode(0xfeff) + '1..5\nok 1\nnot ok 2\nok\n',
    )
    assert.equal(summary.passed, 2)
    assert.equal(summary.failed, 2)
    assert.deepEqual(summary.failures, [
      { name: 'test 2', message: '' },
      { name: 'plan', message: 'Planned 5 tests, ran 3' },
    ])
  })

  it('U12.9 stops at TAP Bail out! and ignores what follows', () => {
    const summary = parseTap(
      'ok 1 - a\r\nBail out! database is down\r\nnot ok 2 - b\r\n1..3\r\n',
    )
    assert.deepEqual(summary, {
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: [{ name: 'Bail out!', message: 'database is down' }],
    })
  })

  it('U12.9 counts what matches in malformed TAP', () => {
    const summary = parseTap(`garbage
okay this is not a test
ok 1 -
not ok 2 - folded
  ---
  message: >
    one
    two
not ok 3 - unterminated yaml
  ---
  message: plain value
not ok 4 - yaml escape json lacks
  ---
  message: "bad \\q escape"
  ...
ok 5 - after`)
    assert.deepEqual(summary, {
      passed: 2,
      failed: 3,
      skipped: 0,
      failures: [
        { name: 'folded', message: 'one two' },
        { name: 'unterminated yaml', message: 'plain value' },
        { name: 'yaml escape json lacks', message: 'bad \\q escape' },
      ],
    })
  })

  it('U12.9 sums several reports with parseTests', () => {
    const summary = parseTests('junit', [JUNIT_NESTED, JUNIT_SINGLE])
    assert.equal(summary.passed, 3)
    assert.equal(summary.failed, 4)
    assert.equal(summary.skipped, 2)
    assert.deepEqual(
      summary.failures.map((failure): string => failure.name),
      [
        'app.Deep › deep fail',
        'app.Inner › text failure',
        'app.Inner › errors out',
        'Solo › no class',
      ],
    )
    assert.equal(parseTests('xunit', [XUNIT]).failed, 2)
    assert.equal(parseTests('tap', ['ok 1', 'not ok 1']).failed, 1)
    assert.deepEqual(parseTests('tap', []), emptySummary())
    assert.throws(
      (): unknown => parseTests('nunit' as TestFormat, ['']),
      TestParseError,
    )
  })

  it('U12.9 rejects malformed XML with the line number', () => {
    assert.throws(
      (): unknown =>
        parseJUnit('<testsuites>\n  <testsuite name="a">\n    <testcase>\n'),
      (error: unknown): boolean =>
        error instanceof TestParseError &&
        /^JUnit: invalid XML at line \d+, column \d+/.test(error.message),
    )
    assert.throws(
      (): unknown => parseXUnit('not xml at all <<<'),
      (error: unknown): boolean =>
        error instanceof TestParseError &&
        /xUnit.*line \d+/.test(error.message),
    )
    assert.throws(
      (): unknown => parseJUnit('<results><x/></results>'),
      /JUnit: expected a <testsuites> or <testsuite> root element/,
    )
    assert.throws(
      (): unknown =>
        parseJUnit(
          '<!DOCTYPE t [<!ENTITY a "aaaa">]><testsuite>&a;</testsuite>',
        ),
      /entity declarations are not allowed/,
    )
    assert.throws((): unknown => parseXUnit(''), TestParseError)
    // Well-formed but absurdly deep input trips the parser's nesting limit.
    const deep =
      '<testsuite>'.repeat(150) +
      '<testcase name="a"/>' +
      '</testsuite>'.repeat(150)
    assert.throws(
      (): unknown => parseJUnit(deep),
      /JUnit: invalid XML: Maximum nested tags exceeded/,
    )
  })

  it('U12.9 rejects input over 50 MB', () => {
    const huge = 'a'.repeat(50 * 1024 * 1024 + 1)
    assert.throws(
      (): unknown => parseTap(huge),
      (error: unknown): boolean =>
        error instanceof TestParseError && /50 MB/.test(error.message),
    )
    assert.throws((): unknown => parseJUnit(huge), TestParseError)
    // Multi-byte characters count by their UTF-8 size, not their length.
    const wide = 'é'.repeat(26 * 1024 * 1024)
    assert.throws((): unknown => parseTap(wide), TestParseError)
  })
})
