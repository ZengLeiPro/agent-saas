#!/usr/bin/env bash
set -euo pipefail

: "${ACR_AK:?ACR_AK is required}"
: "${ACR_SK:?ACR_SK is required}"
: "${ACR_REGION_ID:?ACR_REGION_ID is required}"
: "${ACR_INSTANCE_ID:?ACR_INSTANCE_ID is required}"
: "${ACR_REPO_ID:?ACR_REPO_ID is required}"
[ "$#" -eq 1 ] || { echo 'usage: list-acr-build-records.sh <output.json>' >&2; exit 64; }

output=$1
page_size=100
tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/acr-build-records.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT
page=1
total=''
pages=1
while [ "$page" -le "$pages" ]; do
  page_file="$tmp/page-$page.json"
  aliyun cr ListRepoBuildRecord \
    --mode AK --access-key-id "$ACR_AK" --access-key-secret "$ACR_SK" \
    --region "$ACR_REGION_ID" --InstanceId "$ACR_INSTANCE_ID" \
    --RepoId "$ACR_REPO_ID" --PageNo "$page" --PageSize "$page_size" \
    > "$page_file"
  observed_total="$(node - "$page_file" "$page" <<'NODE'
const [path, expectedPageText] = process.argv.slice(2);
const value = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
const expectedPage = Number(expectedPageText);
const total = Number(value.TotalCount);
if (value.Code !== 'success' || value.IsSuccess !== true) throw new Error('ACR record query failed');
if (Number(value.PageNo) !== expectedPage) throw new Error('ACR record page number changed');
if (!Number.isSafeInteger(total) || total < 0) throw new Error('ACR record total is invalid');
if (!Array.isArray(value.BuildRecords)) throw new Error('ACR build record page is invalid');
process.stdout.write(String(total));
NODE
  )"
  if [ -z "$total" ]; then
    total=$observed_total
    pages=$(( (total + page_size - 1) / page_size ))
    [ "$pages" -gt 0 ] || pages=1
  elif [ "$observed_total" != "$total" ]; then
    echo 'ACR build record total changed during pagination' >&2
    exit 1
  fi
  page=$((page + 1))
done

node - "$tmp" "$total" "$output.tmp" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [directory, expectedTotalText, output] = process.argv.slice(2);
const expectedTotal = Number(expectedTotalText);
const files = fs.readdirSync(directory)
  .filter((name) => /^page-[1-9][0-9]*\.json$/u.test(name))
  .sort((left, right) => Number(left.slice(5, -5)) - Number(right.slice(5, -5)));
const records = files.flatMap((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).BuildRecords);
if (records.length !== expectedTotal) throw new Error('ACR pagination did not return the declared record count');
const ids = records.map((record) => String(record?.BuildRecordId ?? ''));
if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
  throw new Error('ACR pagination returned missing or duplicate BuildRecordId values');
fs.writeFileSync(output, `${JSON.stringify({ Code: 'success', IsSuccess: true, TotalCount: String(expectedTotal), BuildRecords: records })}\n`);
NODE
mv "$output.tmp" "$output"
