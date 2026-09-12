#!/usr/bin/env bash
# Prune unreferenced release copies after a committed deploy.
# Keep set is resolved symlink targets, not "mtime newest N".
# Refuse: symlinks, paths that escape root, empty keep set.

prune_unreferenced_release_dirs() {
  local root="$1"
  shift
  if [ -z "$root" ] || [ "$#" -eq 0 ]; then
    echo 'prune_unreferenced_release_dirs requires ROOT and at least one keep path' >&2
    return 1
  fi
  case "$root" in
    /*) ;;
    *) echo "prune root must be absolute: $root" >&2; return 1 ;;
  esac
  if [ -L "$root" ] || [ ! -d "$root" ]; then
    echo "prune root must be a real directory: $root" >&2
    return 1
  fi
  root="$(readlink -f -- "$root")"

  local keep_resolved=()
  local keep_path resolved
  for keep_path in "$@"; do
    [ -n "$keep_path" ] || continue
    if [ ! -e "$keep_path" ] && [ ! -L "$keep_path" ]; then
      echo "prune keep path is missing: $keep_path" >&2
      return 1
    fi
    resolved="$(readlink -f -- "$keep_path")" || {
      echo "prune keep path cannot be resolved: $keep_path" >&2
      return 1
    }
    keep_resolved+=("$resolved")
  done
  if [ "${#keep_resolved[@]}" -eq 0 ]; then
    echo 'prune keep set resolved empty' >&2
    return 1
  fi

  local had_nullglob=0
  shopt -q nullglob && had_nullglob=1
  shopt -s nullglob
  local entry is_keep keep_item
  for entry in "$root"/*; do
    if [ -L "$entry" ]; then
      echo "ERROR: refuse to prune release symlink: $entry" >&2
      [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
      return 1
    fi
    resolved="$(readlink -f -- "$entry")" || {
      echo "prune entry cannot be resolved: $entry" >&2
      [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
      return 1
    }
    case "$resolved" in
      "$root"|"$root"/*) ;;
      *)
        echo "ERROR: refuse to prune path outside $root: $entry -> $resolved" >&2
        [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
        return 1
        ;;
    esac
    is_keep=false
    for keep_item in "${keep_resolved[@]}"; do
      if [ "$resolved" = "$keep_item" ] || [ "$entry" = "$keep_item" ]; then
        is_keep=true
        break
      fi
    done
    if [ "$is_keep" = true ]; then
      continue
    fi
    rm -rf -- "$entry"
    if [ -e "$entry" ] || [ -L "$entry" ]; then
      echo "ERROR: prune failed to remove $entry" >&2
      [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
      return 1
    fi
  done
  [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
  return 0
}

prune_unreferenced_prefixed_dirs() {
  local prefix="$1"
  shift
  if [ -z "$prefix" ] || [ "$#" -eq 0 ]; then
    echo 'prune_unreferenced_prefixed_dirs requires PREFIX and at least one keep prefix' >&2
    return 1
  fi
  case "$prefix" in
    /*) ;;
    *) echo "prune prefix must be absolute: $prefix" >&2; return 1 ;;
  esac
  local parent
  parent="$(dirname -- "$prefix")"
  if [ -L "$parent" ] || [ ! -d "$parent" ]; then
    echo "prune prefix parent must be a real directory: $parent" >&2
    return 1
  fi
  parent="$(readlink -f -- "$parent")"

  local had_nullglob=0
  shopt -q nullglob && had_nullglob=1
  shopt -s nullglob
  local entry base keep_prefix matched resolved
  for entry in "$prefix"*; do
    if [ -L "$entry" ]; then
      echo "ERROR: refuse to prune symlink: $entry" >&2
      [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
      return 1
    fi
    resolved="$(readlink -f -- "$entry")" || {
      echo "prune prefixed entry cannot be resolved: $entry" >&2
      [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
      return 1
    }
    case "$resolved" in
      "$parent"|"$parent"/*) ;;
      *)
        echo "ERROR: refuse to prune path outside $parent: $entry -> $resolved" >&2
        [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
        return 1
        ;;
    esac
    base="$(basename -- "$entry")"
    matched=false
    for keep_prefix in "$@"; do
      case "$base" in
        "$keep_prefix"|"$keep_prefix"*)
          matched=true
          break
          ;;
      esac
    done
    if [ "$matched" = true ]; then
      continue
    fi
    rm -rf -- "$entry"
    if [ -e "$entry" ] || [ -L "$entry" ]; then
      echo "ERROR: prune failed to remove $entry" >&2
      [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
      return 1
    fi
  done
  [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
  return 0
}

prune_unreferenced_files_matching_keep_ids() {
  local root="$1"
  shift
  if [ -z "$root" ] || [ "$#" -eq 0 ]; then
    echo 'prune_unreferenced_files_matching_keep_ids requires DIR and at least one keep id' >&2
    return 1
  fi
  case "$root" in
    /*) ;;
    *) echo "prune file root must be absolute: $root" >&2; return 1 ;;
  esac
  if [ -L "$root" ] || [ ! -d "$root" ]; then
    echo "prune file root must be a real directory: $root" >&2
    return 1
  fi
  root="$(readlink -f -- "$root")"
  local had_nullglob=0
  shopt -q nullglob && had_nullglob=1
  shopt -s nullglob
  local entry base keep_id matched resolved
  for entry in "$root"/*; do
    if [ -L "$entry" ]; then
      echo "ERROR: refuse to prune symlink: $entry" >&2
      [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
      return 1
    fi
    if [ ! -f "$entry" ] && [ ! -d "$entry" ]; then
      echo "ERROR: refuse to prune special file: $entry" >&2
      [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
      return 1
    fi
    resolved="$(readlink -f -- "$entry")" || {
      echo "prune file cannot be resolved: $entry" >&2
      [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
      return 1
    }
    case "$resolved" in
      "$root"|"$root"/*) ;;
      *)
        echo "ERROR: refuse to prune path outside $root: $entry -> $resolved" >&2
        [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
        return 1
        ;;
    esac
    base="$(basename -- "$entry")"
    matched=false
    for keep_id in "$@"; do
      case "$base" in
        "$keep_id"|"$keep_id".*|"$keep_id"-*)
          matched=true
          break
          ;;
      esac
    done
    if [ "$matched" = true ]; then
      continue
    fi
    rm -rf -- "$entry"
    if [ -e "$entry" ] || [ -L "$entry" ]; then
      echo "ERROR: prune failed to remove $entry" >&2
      [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
      return 1
    fi
  done
  [ "$had_nullglob" -eq 1 ] || shopt -u nullglob
  return 0
}
