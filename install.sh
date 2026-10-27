#!/bin/bash
# Installs Mason from a release: no Node.js or npm needed.
#
#   /bin/bash -c "$(curl -fsSL https://github.com/EdgeApp/mason/releases/latest/download/install.sh)"
#
# Options: --version <x.y.z>   a release other than the latest
#          --user              install under ~/.mason/app and ~/.local/bin, without sudo
#          --from <url>        install a Mason host's copy of the current release (no token)
#
# Releases come from MASON_REPO (public: no token). A private repository
# needs a token: GITHUB_TOKEN, or `gh auth token` when the GitHub CLI is signed in.
set -euo pipefail

repo=${MASON_REPO:-EdgeApp/mason}
api=${MASON_GITHUB_API:-https://api.github.com}
from=${MASON_FROM:-}
version=''
user=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --version) version=${2:?--version needs a version}; shift 2 ;;
    --user) user=1; shift ;;
    --from) from=${2:?--from needs a URL}; shift 2 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

fail() { echo "install.sh: $*" >&2; exit 1; }

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "Mason runs on macOS and Linux, not $(uname -s)" ;;
esac
case $(uname -m) in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac
platform=$os-$arch

if [[ $user == 1 ]]; then
  prefix=${MASON_PREFIX:-$HOME/.mason/app}
  bindir=${MASON_BIN:-$HOME/.local/bin}
  as_root=()
else
  prefix=${MASON_PREFIX:-/opt/mason}
  bindir=${MASON_BIN:-/usr/local/bin}
  # One sudo prompt, like Homebrew, unless already root or the prefix is writable.
  if [[ $(id -u) == 0 ]] || { mkdir -p "$prefix" 2>/dev/null && [[ -w $prefix ]]; }; then
    as_root=()
  else
    as_root=(sudo)
  fi
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/mason-install.XXXXXX")
trap 'rm -rf "$work"' EXIT

fetch() { # fetch <url> <file> [curl options…]
  local url=$1 file=$2
  shift 2
  curl -fsSL --retry 3 "$@" -o "$file" "$url" || fail "could not download $url"
}

if [[ -n $from ]]; then
  # A Mason host serves the master's current release; nodes need no token.
  fetch "$from/releases/current/SHA256SUMS" "$work/SHA256SUMS"
  tarball=$(awk '{print $2}' "$work/SHA256SUMS" | grep -E "^mason-[0-9][^ ]*-$platform\\.tar\\.gz$" | head -1 || true)
  [[ -n $tarball ]] || fail "this host's release has no $platform tarball"
  fetch "$from/releases/current/$tarball" "$work/$tarball"
  fetch "$from/install.sh" "$work/install.sh"
else
  token=${GITHUB_TOKEN:-}
  if [[ -z $token ]] && command -v gh >/dev/null 2>&1; then token=$(gh auth token 2>/dev/null || true); fi
  auth=(-H "X-GitHub-Api-Version: 2022-11-28")
  [[ -z $token ]] || auth+=(-H "Authorization: Bearer $token")
  if [[ -n $version ]]; then route="releases/tags/v$version"; else route=releases/latest; fi
  if ! curl -fsSL --retry 3 "${auth[@]}" -H 'Accept: application/vnd.github+json' -o "$work/release.json" "$api/repos/$repo/$route"; then
    if [[ -n $token ]]; then fail "$repo has no ${version:-latest} release this token can read"; fi
    fail "$repo has no ${version:-latest} release (a private repository needs GITHUB_TOKEN, or 'gh auth login')"
  fi

  # Each asset object holds its API URL and then its name.
  asset() {
    local url
    url=$(tr -d '\n\r' < "$work/release.json" | sed -E 's/"[[:space:]]*:[[:space:]]*/":/g' | tr '{' '\n' | grep "\"name\":\"$1\"" | grep -o '"url":"[^"]*/releases/assets/[0-9]*"' | head -1 | sed 's/"url":"\(.*\)"/\1/' || true)
    [[ -n $url ]] || fail "the release has no $1"
    echo "$url"
  }
  sums_url=$(asset SHA256SUMS)
  fetch "$sums_url" "$work/SHA256SUMS" "${auth[@]}" -H 'Accept: application/octet-stream'
  tarball=$(awk '{print $2}' "$work/SHA256SUMS" | grep -E "^mason-[0-9][^ ]*-$platform\\.tar\\.gz$" | head -1 || true)
  [[ -n $tarball ]] || fail "the release has no $platform tarball"
  fetch "$(asset "$tarball")" "$work/$tarball" "${auth[@]}" -H 'Accept: application/octet-stream'
  fetch "$(asset install.sh)" "$work/install.sh" "${auth[@]}" -H 'Accept: application/octet-stream'
fi

release=${tarball#mason-}
release=${release%-$platform.tar.gz}
[[ -z $version || $version == "$release" ]] || fail "asked for $version but the release is $release"

# The tarball must match the release's SHA256SUMS.
expected=$(awk -v f="$tarball" '$2 == f {print $1}' "$work/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$work/$tarball" | awk '{print $1}')
else actual=$(shasum -a 256 "$work/$tarball" | awk '{print $1}'); fi
[[ -n $expected && $expected == "$actual" ]] || fail "checksum mismatch for $tarball: refusing to install it"

dest=$prefix/$release
if [[ -x $dest/mason && -f $dest/.sha256 && $(cat "$dest/.sha256") == "$actual" ]]; then
  echo "Mason $release is already installed in $dest"
else
  ${as_root[@]+"${as_root[@]}"} mkdir -p "$prefix"
  ${as_root[@]+"${as_root[@]}"} rm -rf "$dest.partial"
  ${as_root[@]+"${as_root[@]}"} mkdir -p "$dest.partial"
  ${as_root[@]+"${as_root[@]}"} tar -xzf "$work/$tarball" -C "$dest.partial" --strip-components=1
  # The release stays beside the install, so a master here can serve and push it.
  ${as_root[@]+"${as_root[@]}"} mkdir -p "$dest.partial/release"
  ${as_root[@]+"${as_root[@]}"} cp "$work/SHA256SUMS" "$work/$tarball" "$work/install.sh" "$dest.partial/release/"
  echo "$actual" | ${as_root[@]+"${as_root[@]}"} tee "$dest.partial/.sha256" >/dev/null
  ${as_root[@]+"${as_root[@]}"} rm -rf "$dest"
  ${as_root[@]+"${as_root[@]}"} mv "$dest.partial" "$dest"
  echo "Installed Mason $release in $dest"
fi
# Services run $prefix/current/mason, so an update only repoints these links.
${as_root[@]+"${as_root[@]}"} ln -sfn "$release" "$prefix/current"
${as_root[@]+"${as_root[@]}"} mkdir -p "$bindir"
${as_root[@]+"${as_root[@]}"} ln -sfn "$prefix/current/mason" "$bindir/mason"
echo "Linked $bindir/mason"
echo
echo "Next:"
echo "  mason                         run a master (prints a setup code)"
if [[ $user == 1 ]]; then
  echo "  mason worker --install        install a worker service for this user"
else
  echo "  sudo mason worker --install   install a worker service"
  echo "  sudo mason host --install     install the host"
fi
