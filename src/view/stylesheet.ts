import { breakpoints, cssVariables } from './tokens.js'

/** The bundled fonts, served by Mason. */
const faces = `@font-face{font-family:'Geist';src:url(/assets/fonts/geist-variable.woff2) format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'JetBrains Mono';src:url(/assets/fonts/jetbrains-mono-variable.woff2) format('woff2');font-weight:100 800;font-display:swap}
@font-face{font-family:'Material Symbols Outlined';src:url(/assets/fonts/material-symbols-outlined-subset.woff2) format('woff2');font-weight:400;font-display:block}`

/** Base: type, controls, the classes the existing pages use. */
const base = `:root{${cssVariables()};color-scheme:light}
*{box-sizing:border-box}
html{font:14px/20px var(--font-sans);color:var(--color-text);background:var(--color-surface);-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh}
h1{font-size:32px;line-height:40px;font-weight:600;letter-spacing:-.02em;margin:0 0 8px}
h2{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em;margin:0 0 12px}
h3{font-size:16px;line-height:24px;font-weight:600;margin:0 0 8px}
p{margin:0 0 12px;color:var(--color-text-muted)}
a{color:var(--color-primary);text-underline-offset:2px}
code,kbd,pre,.mono{font-family:var(--font-mono);font-size:12px;letter-spacing:-.005em}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--color-panel-low);border:1px solid var(--color-border);border-radius:var(--radius);padding:12px}
.command{display:flex;align-items:flex-start;gap:8px;margin:8px 0}.command pre{flex:1;min-width:0;margin:0}.panel li .command pre.mono{white-space:pre-wrap;overflow-wrap:anywhere;overflow:visible;text-overflow:clip}.command .copy{flex:none}.panel li:has(>.command){flex-wrap:wrap}.panel li>.command{flex:1 1 360px;min-width:0}
small{display:block;color:var(--color-text-muted);font-size:12px;line-height:18px;margin:4px 0}
.icon{font-family:'Material Symbols Outlined';font-weight:400;font-style:normal;font-size:20px;line-height:1;display:inline-block;vertical-align:middle;-webkit-font-smoothing:antialiased;user-select:none}
.button,button{display:inline-flex;align-items:center;gap:6px;min-height:36px;background:var(--color-primary);color:var(--color-on-primary);border:1px solid var(--color-primary);border-radius:var(--radius);padding:8px 14px;font:500 14px/20px var(--font-sans);cursor:pointer;text-decoration:none;white-space:nowrap}
.button:hover,button:hover{background:var(--color-primary-pressed);border-color:var(--color-primary-pressed)}
.secondary,.button.secondary,button.secondary{background:var(--color-panel);color:var(--color-text);border-color:var(--color-border-strong)}
.secondary:hover,button.secondary:hover{background:var(--color-panel-low);border-color:var(--color-border-strong)}
.danger,button.danger{background:var(--color-panel);color:var(--color-error-text);border-color:var(--color-error-text)}.button.danger-fill,button.danger-fill{background:var(--color-error-text);color:var(--color-on-primary);border-color:var(--color-error-text)}.actions>details.action{margin:0}.actions>details.action[open]{flex-basis:100%}table.storage-locations{width:100%}table.storage-locations th{text-align:left}table.storage-locations td{vertical-align:top}table.storage-locations td:last-child{white-space:normal;width:auto}table.storage-locations details.action{margin:0}table.storage-locations .action-body{max-width:360px;white-space:normal}
.register-device{background:var(--color-primary)}
a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}
form{margin:0}
label{display:block;margin:16px 0 6px;font-weight:500}
input,select,textarea{display:block;border:1px solid var(--color-border-strong);border-radius:var(--radius);background:var(--color-panel);color:var(--color-text);font:inherit;padding:9px 10px;width:100%;max-width:450px;min-height:40px}
input[type=checkbox],input[type=radio]{display:inline-block;width:18px;height:18px;min-height:0;padding:0;margin:0;accent-color:var(--color-primary);vertical-align:middle}
label.check{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-weight:400;margin:8px 0}
ol.wizard-steps{padding:0;list-style:none}
.card{border:1px solid var(--color-border);border-radius:var(--radius-panel);background:var(--color-panel);padding:20px;margin-bottom:16px;max-width:760px}
.row{padding:14px 0;border-bottom:1px solid var(--color-border);display:flex;justify-content:space-between;gap:16px;align-items:center}
.row:last-child{border:0}.row p{margin:4px 0;word-break:break-word}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.stack{display:flex;flex-direction:column;align-items:flex-start;gap:12px}
.notice{padding:12px 14px;background:var(--color-warning-soft);color:var(--color-warning);border:1px solid #F5D9A8;border-radius:var(--radius);margin:0 0 16px}
.notice a{color:var(--color-warning)}
.device-state{font-size:13px;color:var(--color-text-muted)}.device-id{overflow-wrap:anywhere;font-family:var(--font-mono);font-size:12px}
.breadcrumbs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;font:500 12px/16px var(--font-mono);text-transform:uppercase;letter-spacing:.04em}
.breadcrumbs a{text-decoration:none}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`

/** The shell: top bar, navigation rail and the main column. */
const shell = `.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;height:56px;padding:0 16px;background:var(--color-panel);border-bottom:1px solid var(--color-border)}
.brand{display:flex;align-items:center;gap:8px;color:var(--color-text);text-decoration:none;font-size:16px;font-weight:600;margin-right:8px}
.brand img{width:32px;height:32px}
.brand .mono{font-size:11px;color:var(--color-text-muted);background:var(--color-panel-low);border:1px solid var(--color-border);border-radius:var(--radius);padding:1px 6px}
.topbar .search{flex:1;max-width:520px;justify-content:flex-start;background:var(--color-panel-low);color:var(--color-text-muted);border-color:var(--color-border);font-weight:400}
.topbar .search:hover{background:var(--color-panel-high);border-color:var(--color-border)}
.topbar .search kbd{margin-left:auto;border:1px solid var(--color-border-strong);border-radius:var(--radius);padding:0 4px;color:var(--color-text-muted)}
.topbar .spacer{flex:1}
.topbar .status{display:flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:12px;color:var(--color-text-muted);border:1px solid var(--color-border);border-radius:var(--radius);padding:4px 8px;white-space:nowrap}
.topbar nav{display:flex;gap:8px;align-items:center}
.topbar details{position:relative}
.topbar summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:4px;min-height:36px;min-width:36px;justify-content:center;border-radius:var(--radius);color:var(--color-text)}
.topbar summary::-webkit-details-marker{display:none}
.topbar summary:hover{background:var(--color-panel-low)}
.count{background:var(--color-primary);color:var(--color-on-primary);border-radius:var(--radius-full, 9999px);font:600 11px/16px var(--font-mono);padding:0 5px}
.menu{position:absolute;right:0;top:44px;width:320px;max-width:calc(100vw - 32px);background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:8px;z-index:30}
.menu ul{list-style:none;margin:0;padding:0}.menu li{padding:8px;border-bottom:1px solid var(--color-border)}.menu li:last-child{border:0}
.menu .who{padding:8px}.menu .who strong{display:block}
.avatar{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9999px;background:var(--color-primary);color:var(--color-on-primary);font-weight:600}
.layout{display:flex;min-height:calc(100vh - 56px)}
.rail{flex:0 0 240px;border-right:1px solid var(--color-border);background:var(--color-panel);padding:12px 8px}
.rail .section{font:500 11px/14px var(--font-mono);text-transform:uppercase;letter-spacing:.06em;color:var(--color-text-muted);padding:8px 12px}
.rail a{display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:var(--radius);color:var(--color-text);text-decoration:none;min-height:40px}
.rail a:hover{background:var(--color-panel-low)}
.rail a[aria-current=page]{background:var(--color-panel-low);box-shadow:inset 3px 0 0 var(--color-accent);color:var(--color-primary);font-weight:500}
main{flex:1;min-width:0;padding:24px 32px;max-width:1440px}
.phone main{width:100%;max-width:760px;margin:0 auto;padding:24px 16px}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.page-head p{margin:0}
dialog.search-dialog{border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:0;width:min(640px,calc(100vw - 32px));margin:10vh auto auto;background:var(--color-panel);color:var(--color-text)}
dialog.search-dialog::backdrop{background:rgba(11,28,48,.35)}
.search-dialog input{max-width:none;border:0;border-bottom:1px solid var(--color-border);border-radius:0;font-size:16px;min-height:52px;padding:0 16px}
.search-dialog ul{list-style:none;margin:0;padding:8px;max-height:60vh;overflow:auto}
.search-dialog li a{display:flex;gap:12px;align-items:center;padding:8px;border-radius:var(--radius);text-decoration:none;color:var(--color-text)}
.search-dialog li a:hover,.search-dialog li a[aria-selected=true]{background:var(--color-panel-low)}
.search-dialog li small{margin:0}
.search-dialog .empty{padding:16px;color:var(--color-text-muted)}`

/** Dashboard, chips, statuses and cards. */
const components = `.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:20px}
.tile{display:flex;gap:12px;align-items:center;background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:16px}
.tile .icon{color:var(--color-accent);font-size:24px}
.tile strong{display:block;font-size:24px;line-height:32px;font-weight:600}
.tile div>span{font:500 11px/14px var(--font-mono);text-transform:uppercase;letter-spacing:.06em;color:var(--color-text-muted)}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
.chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--color-border-strong);border-radius:var(--radius);padding:4px 10px;min-height:32px;color:var(--color-text);text-decoration:none;font-size:13px;background:var(--color-panel)}
.chip[aria-current=true]{background:var(--color-slate);border-color:var(--color-slate);color:var(--color-on-slate)}
.platform{display:inline-flex;align-items:center;gap:2px;font:500 11px/16px var(--font-mono);color:var(--color-indigo);background:var(--color-indigo-soft);border-radius:var(--radius);padding:1px 6px}
.platform .icon{font-size:14px}
.columns{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:20px;align-items:start}
.panel{background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:16px;margin-bottom:16px}
.panel h2{font-size:16px;line-height:24px;display:flex;align-items:center;gap:8px}
.panel h2 .icon{color:var(--color-accent)}
.panel ul{list-style:none;margin:0;padding:0}
.panel li{padding:10px 0;border-bottom:1px solid var(--color-border);display:flex;gap:10px;align-items:center;justify-content:space-between}
.panel li:last-child{border:0}
.panel li div{min-width:0}
.panel li .mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.project{background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-panel);margin-bottom:16px;overflow:hidden}
.project header{display:flex;align-items:flex-start;gap:12px;padding:16px;border-bottom:1px solid var(--color-border)}
.project header > div{flex:1;min-width:0}
.project header h2{margin:0;font-size:18px;overflow-wrap:anywhere}
.project header h2 a{color:var(--color-text);text-decoration:none}
.project .meta{display:flex;gap:16px;flex-wrap:wrap;margin-top:6px;color:var(--color-text-muted);font-size:12px}
.panel .actions>form+form{margin-top:0}
.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 16px;margin:8px 0}.facts dt{color:var(--color-text-muted)}.facts dd{margin:0;overflow-wrap:anywhere}
.project .meta .mono{color:var(--color-text)}
.project .apps{padding:8px 16px 16px}
.project .apps h3{font:500 11px/14px var(--font-mono);text-transform:uppercase;letter-spacing:.06em;color:var(--color-text-muted);margin:8px 0}
.app-row{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--color-border);border-radius:var(--radius);margin-bottom:8px;background:var(--color-panel-low)}
.app-row .mono{font-size:13px;color:var(--color-text);overflow-wrap:anywhere}
.app-row .runs{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.run-chip{display:inline-flex;align-items:center;gap:6px;font:500 12px/16px var(--font-mono);border:1px solid var(--color-border);border-radius:var(--radius);padding:3px 8px;background:var(--color-panel);color:var(--color-text);text-decoration:none}
.dot{display:inline-block;width:8px;height:8px;border-radius:9999px;background:var(--color-cancelled);flex:none}
.dot.succeeded{background:var(--color-success)}.dot.running{background:var(--color-running)}.dot.failed,.dot.timed_out{background:var(--color-failed)}.dot.unstable,.dot.waiting{background:var(--color-warning)}.dot.queued{background:var(--color-border-strong)}
.state-failed{color:var(--color-error-text)}.state-succeeded{color:var(--color-success-text)}.state-running{color:var(--color-indigo)}
.progress{height:4px;background:var(--color-panel-high);border-radius:9999px;overflow:hidden;margin-top:6px}
.progress span{display:block;height:100%;background:var(--color-accent)}
table.list{width:100%;border-collapse:collapse;background:var(--color-panel);border:1px solid var(--color-border);border-radius:var(--radius-panel)}
table.list th,table.list td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--color-border);vertical-align:top}
table.list th{font:500 11px/14px var(--font-mono);text-transform:uppercase;letter-spacing:.06em;color:var(--color-text-muted)}
table.list tr:last-child td{border-bottom:0}
.empty-state{padding:24px;text-align:center;color:var(--color-text-muted);background:var(--color-panel);border:1px dashed var(--color-border-strong);border-radius:var(--radius-panel)}`

/** The run view: graph, timeline, stage panel, steps, log and stage list. */
const run = `.run-head h1{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.run-head h1 a{color:var(--color-text);text-decoration:none}.run-head h1>span{font-size:14px;font-weight:500;display:inline-flex;align-items:center;gap:6px}
.run-meta{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;font-size:13px}.run-meta .icon{font-size:16px}
.run-description{color:var(--color-text);font-weight:500}
.run-tabs{margin-bottom:12px}
.graph-panel{position:relative;padding:8px}.graph-tools{position:absolute;top:8px;right:8px;z-index:1}.graph-tools button{min-height:32px;padding:4px 6px}
.graph-scroll{overflow:auto;max-height:70vh;background:var(--color-panel)}
.pipeline-graph{display:block}.pipeline-graph .rail{fill:none;stroke:var(--color-border-strong);stroke-width:2}
.pipeline-graph .rail.related{stroke:var(--color-accent)}.pipeline-graph.focused .rail:not(.related){opacity:.35}.pipeline-graph.focused .bubble:not(.related):not(.selected){opacity:.45}
.pipeline-graph .bubble circle{fill:var(--color-cancelled);stroke:var(--color-panel);stroke-width:3}
.pipeline-graph .bubble.start circle,.pipeline-graph .bubble.end circle{fill:var(--color-slate)}
.pipeline-graph .status-succeeded circle{fill:var(--color-success)}.pipeline-graph .status-failed circle,.pipeline-graph .status-timed_out circle,.pipeline-graph .status-interrupted circle{fill:var(--color-failed)}
.pipeline-graph .status-unstable circle,.pipeline-graph .status-awaiting_approval circle{fill:var(--color-warning)}.pipeline-graph .status-running circle{fill:var(--color-running)}
.pipeline-graph .status-queued circle{fill:var(--color-panel);stroke:var(--color-border-strong);stroke-width:2;stroke-dasharray:3 3}.pipeline-graph .status-skipped circle{fill:var(--color-panel-high)}
.pipeline-graph .ring{fill:none!important;stroke:var(--color-running)!important;stroke-width:2!important;stroke-dasharray:20 80;animation:spin 1.2s linear infinite;transform-box:fill-box;transform-origin:center}
@keyframes spin{to{transform:rotate(360deg)}}
.pipeline-graph .label{font:500 12px var(--font-sans);fill:var(--color-text);text-anchor:middle}.pipeline-graph .row-label{font:500 11px var(--font-mono);fill:var(--color-text-muted);text-anchor:start}
.pipeline-graph .glyph{font:16px 'Material Symbols Outlined';fill:var(--color-on-primary);text-anchor:middle}
.pipeline-graph .selected circle{stroke:var(--color-accent);stroke-width:4}.pipeline-graph a:focus-visible circle{stroke:var(--color-accent)}
.timeline{display:grid;gap:6px}.timeline-row{display:grid;grid-template-columns:160px 1fr;gap:12px;align-items:center}.timeline-row .mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.timeline-track{position:relative;height:14px;background:var(--color-panel-low);border-radius:var(--radius)}.timeline-bar{position:absolute;top:2px;bottom:2px;border-radius:2px;background:var(--color-border-strong)}
.timeline-bar.status-succeeded{background:var(--color-success)}.timeline-bar.status-failed{background:var(--color-failed)}.timeline-bar.status-running{background:var(--color-running)}.timeline-bar.critical{outline:2px solid var(--color-accent);outline-offset:1px}
.run-body{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;align-items:start}
.stage-panel h2 .dot{width:10px;height:10px}.stage-meta{font-size:13px}
.steps{list-style:none;margin:0 0 12px;padding:0}.steps li{border-bottom:1px solid var(--color-border)}.steps li:last-child{border:0}.steps a{display:flex;gap:8px;align-items:center;padding:6px 4px;color:var(--color-text);text-decoration:none}.steps a:hover,.steps .open a{background:var(--color-panel-low)}.steps small{margin:0 0 0 auto}
.log-actions{margin:8px 0}.log-actions .wrap{display:inline-flex;gap:6px;align-items:center;margin:0;font-weight:400}.log-actions .wrap input{width:auto;min-height:0}
pre.log{background:var(--color-terminal);color:var(--color-terminal-text);border:0;border-radius:var(--radius-panel);padding:12px 0;max-height:60vh;overflow:auto;white-space:pre;counter-reset:none;font-size:12px;line-height:18px}
pre.log.wrap{white-space:pre-wrap}pre.log .line{display:block;padding:0 12px 0 64px;position:relative;min-height:18px}pre.log .line::before{content:attr(data-line);position:absolute;left:0;width:48px;text-align:right;color:var(--color-line-number);user-select:none}
.ansi-red,.ansi-bright-red{color:var(--color-ansi-red)}.ansi-green,.ansi-bright-green{color:var(--color-ansi-green)}.ansi-yellow,.ansi-bright-yellow{color:var(--color-ansi-yellow)}.ansi-blue,.ansi-bright-blue{color:var(--color-ansi-blue)}.ansi-magenta,.ansi-bright-magenta{color:var(--color-ansi-magenta)}.ansi-cyan,.ansi-bright-cyan{color:var(--color-ansi-cyan)}.ansi-black,.ansi-bright-black{color:var(--color-ansi-gray)}.ansi-white,.ansi-bright-white{color:var(--color-terminal-text)}.ansi-bold{font-weight:700}.ansi-underline{text-decoration:underline}
.stage-list input,.stage-list select{max-width:none;margin-bottom:8px}.stage-list .tree{list-style:none;margin:0;padding:0}.stage-list .tree a{display:flex;gap:8px;align-items:center;padding:6px;border-radius:var(--radius);color:var(--color-text);text-decoration:none}.stage-list .tree a[aria-current=true]{background:var(--color-panel-low);box-shadow:inset 3px 0 0 var(--color-accent)}.stage-list .tree small{margin:0 0 0 auto}
.history tr.current td{background:var(--color-panel-low)}.chips-cell span{margin-right:3px}
ul.plain{list-style:none;padding:0;margin:0 0 12px}ul.checklist li{display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:4px 0}.panel form+h3,.panel form+form,.panel form+.actions{margin-top:20px}.approval{border:1px solid var(--color-border);border-radius:var(--radius);padding:12px;margin-bottom:12px;background:var(--color-warning-soft)}.approval form{display:inline-block;margin-right:8px}
details.request{position:relative}details.request>summary{list-style:none}
table.compact th,table.compact td{width:1%;white-space:nowrap;padding-right:16px}table.compact th:first-child,table.compact td:first-child{width:auto}.icon-only{min-height:28px;padding:4px 6px;margin-right:6px;vertical-align:middle}details.action{margin:8px 0}details.action>summary{list-style:none}details.action>summary::-webkit-details-marker{display:none}details.action[open]>summary{margin-bottom:8px}details.action>.action-body{border-left:2px solid var(--color-border);padding:4px 0 4px 12px}.field{margin:0 0 12px}.field>label{display:block;font-weight:500}.field>small.hint{margin:0 0 4px}ol.howto{margin:0 0 12px;padding-left:20px}.panel ol.howto>li,ol.howto>li{display:list-item;margin:0 0 12px;padding:0 0 12px}ol.howto>li::marker{font-weight:500}ol.howto>li>strong{display:block;margin-bottom:4px}ol.howto>li>small.hint{display:block}details.reveal>summary{list-style:none;display:inline-flex}details.reveal>summary::-webkit-details-marker{display:none}details.reveal[open]>summary{display:none}details.request>.panel{position:absolute;right:0;top:44px;width:340px;z-index:5}`

/** The tester catalog, install and device pages: phone-first lists. */
const catalog = `.platforms{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--color-border-strong);border-radius:var(--radius);background:var(--color-panel)}
.platforms a{padding:6px 10px;border-radius:var(--radius);font-size:13px;text-decoration:none;color:var(--color-text);min-height:36px;display:flex;align-items:center}
.platforms a[aria-current=true]{background:var(--color-slate);color:var(--color-on-slate)}
.intro{margin-bottom:20px}
.app-list,.build-list{max-width:760px}
.app-card,.list-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px;border:1px solid var(--color-border);border-radius:var(--radius-panel);background:var(--color-panel);margin-bottom:8px;color:var(--color-text);text-decoration:none;width:100%;text-align:left;font-weight:400}
.app-card:hover,.list-row:hover{background:var(--color-panel-low);border-color:var(--color-border-strong)}
button.list-row{border-color:var(--color-border);min-height:0}
.app-card div{flex:1;min-width:0}.app-card h2{margin:0;font-size:16px;line-height:24px}
.app-card small{overflow-wrap:anywhere;font-family:var(--font-mono)}
.app-index{color:var(--color-indigo);font:500 12px/16px var(--font-mono)}
.list-row strong{overflow-wrap:anywhere}
.build-row strong{font-size:16px}
.build-number{color:var(--color-text-muted);font-family:var(--font-mono);font-weight:400}
.build-row code{font-size:12px;color:var(--color-indigo)}
.download-label{font-size:13px;color:var(--color-primary);font-weight:500}`

/** Breakpoints: tablet collapses the rail to icons; phone is one column. */
const responsive = `@media(max-width:${breakpoints.desktop - 1}px){.run-body{grid-template-columns:minmax(0,1fr)}.rail{flex-basis:64px;padding:12px 6px}.rail .label,.rail .section{display:none}.rail a{justify-content:center;padding:8px}.columns{grid-template-columns:minmax(0,1fr)}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.topbar .status{display:none}}
@media(max-width:${breakpoints.tablet - 1}px){.topbar{flex-wrap:wrap;height:auto;min-height:56px;padding:8px 12px;row-gap:8px}.topbar nav{order:3;flex:1 0 100%;flex-wrap:wrap}.layout{flex-direction:column;min-height:0}.rail{display:flex;flex-basis:auto;border-right:0;border-bottom:1px solid var(--color-border);overflow-x:auto;padding:4px 8px}.rail a{flex:none}main{padding:16px}.topbar{gap:8px;padding:0 12px}.topbar .search span:not(.icon),.topbar .search kbd,.brand .mono,.brand span{display:none}.topbar .search{flex:0 0 auto}.tiles{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.tile{padding:12px}.tile strong{font-size:20px}h1{font-size:26px;line-height:34px}.row,.app-row,.project header{flex-direction:column;align-items:flex-start}.app-row .runs{justify-content:flex-start}.app-card,.list-row{padding:14px}.platforms a{min-height:44px}}`

export const stylesheet = [
  faces,
  base,
  shell,
  components,
  run,
  catalog,
  responsive,
].join('\n')
