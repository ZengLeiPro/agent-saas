import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  BLOCKED_ANDROID_PERMISSIONS,
  DATA_EXTRACTION_RULES_RESOURCE,
  FULL_BACKUP_RULES_RESOURCE,
} = require('../plugins/withMobilePrivacyControls');
const { verifyGeneratedAndroidSigningConfig } = require('../plugins/withAndroidSigningConfig');
const {
  validateManifestSchema,
  readJson,
  RELEASE_MANIFEST_PATH,
} = require('./release-manifest.cjs');

const HERE = dirname(fileURLToPath(import.meta.url));
export const MOBILE_ROOT = resolve(HERE, '..');
export const GOLDEN_ROOT = join(MOBILE_ROOT, 'native-policy', 'goldens');
export const PROFILES = Object.freeze(['ios', 'store', 'enterprise']);
const INSTALL_PERMISSION = 'android.permission.REQUEST_INSTALL_PACKAGES';
const APPROVED_ANDROID_PERMISSIONS = new Set([
  'android.permission.CAMERA',
  'android.permission.INTERNET',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.RECORD_AUDIO',
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
  'android.permission.VIBRATE',
]);
const DANGEROUS_ANDROID_PERMISSIONS = new Set([
  ...BLOCKED_ANDROID_PERMISSIONS,
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.READ_CONTACTS',
  'android.permission.READ_PHONE_STATE',
  'android.permission.READ_SMS',
  'android.permission.SEND_SMS',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.WRITE_CONTACTS',
]);
const APPROVED_IOS_USAGE = Object.freeze({
  NSCameraUsageDescription: '用于在用户选择拍照时拍摄并上传附件',
  NSFaceIDUsageDescription: '用于在您明确开启应用锁后，以 Face ID 解锁本机上的 Agent SaaS 界面',
  NSMicrophoneUsageDescription: '用于录制并发送语音消息',
  NSPhotoLibraryUsageDescription: '用于在用户选择图库时选取图片或视频作为附件、头像',
});
const IOS_LOCATION_KEYS = Object.freeze([
  'NSLocationAlwaysAndWhenInUseUsageDescription',
  'NSLocationAlwaysUsageDescription',
  'NSLocationTemporaryUsageDescriptionDictionary',
  'NSLocationWhenInUseUsageDescription',
]);
const APPROVED_ENTITLEMENTS = new Set([
  'aps-environment',
  'com.apple.developer.associated-domains',
  'com.apple.security.application-groups',
  'keychain-access-groups',
]);
const ENTITLEMENT_VALUE_KEYS = new Set([
  'aps-environment',
  'com.apple.security.application-groups',
  'keychain-access-groups',
]);
const APS_ENVIRONMENT_KEY = 'aps-environment';
/** APNs 推送环境：production 档位走生产网关，其余档位一律 sandbox（development）。 */
function expectedApsEnvironment(releaseProfile) {
  return releaseProfile === 'production' ? 'production' : 'development';
}

function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, token) => {
    if (token[0] === '#') {
      const radix = token[1].toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? token.slice(2) : token.slice(1);
      return String.fromCodePoint(Number.parseInt(digits, radix));
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[token];
  });
}

/** Small deterministic XML parser: decisions consume an element tree, never regex-only matches. */
export function parseXml(source, label = 'XML') {
  if (typeof source !== 'string' || source.length === 0) throw new Error(`${label} is empty`);
  if (/<!ENTITY/i.test(source)) {
    throw new Error(`${label} contains a forbidden entity declaration`);
  }
  // Apple plists carry this fixed public identifier. It is recognized but
  // never resolved; every other DTD remains fail-closed.
  source = source.replace(
    /<!DOCTYPE\s+plist\s+PUBLIC\s+"-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"\s+"https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd"\s*>/i,
    '',
  );
  if (/<!DOCTYPE/i.test(source)) throw new Error(`${label} contains a forbidden DTD declaration`);
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let index = 0;
  const skipSpace = () => {
    while (/\s/.test(source[index] ?? '')) index += 1;
  };
  while (index < source.length) {
    if (source[index] !== '<') {
      const end = source.indexOf('<', index);
      const stop = end === -1 ? source.length : end;
      stack.at(-1).text += decodeXml(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end < 0) throw new Error(`${label} has an unterminated comment`);
      index = end + 3;
      continue;
    }
    if (source.startsWith('<?', index)) {
      const end = source.indexOf('?>', index + 2);
      if (end < 0) throw new Error(`${label} has an unterminated declaration`);
      index = end + 2;
      continue;
    }
    if (source.startsWith('<![CDATA[', index)) {
      const end = source.indexOf(']]>', index + 9);
      if (end < 0) throw new Error(`${label} has unterminated CDATA`);
      stack.at(-1).text += source.slice(index + 9, end);
      index = end + 3;
      continue;
    }
    if (source.startsWith('</', index)) {
      index += 2;
      skipSpace();
      const match = /^[A-Za-z_][\w:.-]*/.exec(source.slice(index));
      if (!match) throw new Error(`${label} has an invalid closing tag`);
      index += match[0].length;
      skipSpace();
      if (source[index] !== '>') throw new Error(`${label} closing tag is malformed`);
      index += 1;
      const node = stack.pop();
      if (!node || node.name !== match[0]) throw new Error(`${label} closing tag mismatch`);
      continue;
    }
    index += 1;
    skipSpace();
    const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(source.slice(index));
    if (!nameMatch) throw new Error(`${label} has an invalid element name`);
    const node = { name: nameMatch[0], attrs: {}, children: [], text: '' };
    index += nameMatch[0].length;
    let selfClosing = false;
    while (index < source.length) {
      skipSpace();
      if (source.startsWith('/>', index)) {
        selfClosing = true;
        index += 2;
        break;
      }
      if (source[index] === '>') {
        index += 1;
        break;
      }
      const attrMatch = /^[A-Za-z_][\w:.-]*/.exec(source.slice(index));
      if (!attrMatch) throw new Error(`${label} has an invalid attribute`);
      const attr = attrMatch[0];
      index += attr.length;
      skipSpace();
      if (source[index] !== '=') throw new Error(`${label} attribute ${attr} has no value`);
      index += 1;
      skipSpace();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") throw new Error(`${label} attribute ${attr} is unquoted`);
      index += 1;
      const end = source.indexOf(quote, index);
      if (end < 0) throw new Error(`${label} attribute ${attr} is unterminated`);
      node.attrs[attr] = decodeXml(source.slice(index, end));
      index = end + 1;
    }
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`${label} has unclosed elements`);
  if (root.children.length !== 1) throw new Error(`${label} must have exactly one root element`);
  return root.children[0];
}

function childElements(node, name) {
  return node.children.filter((child) => !name || child.name === name);
}

function plistValue(node, label) {
  if (!node) throw new Error(`${label} has a missing plist value`);
  switch (node.name) {
    case 'dict': {
      const values = childElements(node);
      const result = {};
      for (let i = 0; i < values.length; i += 2) {
        const key = values[i];
        if (key?.name !== 'key' || !values[i + 1]) throw new Error(`${label} has a malformed dict`);
        if (Object.hasOwn(result, key.text)) throw new Error(`${label} has duplicate key ${key.text}`);
        result[key.text] = plistValue(values[i + 1], label);
      }
      return result;
    }
    case 'array':
      return childElements(node).map((child) => plistValue(child, label));
    case 'true':
      return true;
    case 'false':
      return false;
    case 'integer':
      return Number.parseInt(node.text.trim(), 10);
    case 'real':
      return Number.parseFloat(node.text.trim());
    case 'string':
    case 'data':
    case 'date':
      return node.text;
    default:
      throw new Error(`${label} contains unsupported plist node ${node.name}`);
  }
}

export function parsePlist(source, label = 'plist') {
  const root = parseXml(source, label);
  if (root.name !== 'plist') throw new Error(`${label} root must be plist`);
  return plistValue(childElements(root)[0], label);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function finding(code, path, message, severity = 'error') {
  return { code, severity, path, message };
}

function safeRelative(root, path) {
  const value = relative(root, path).split(sep).join('/');
  if (!value || value === '.') return '<generated-root>';
  if (value === '..' || value.startsWith('../')) throw new Error('resolved path escaped generated root');
  return value;
}

function assertSafeTree(root, rootArgument, findings) {
  if (rootArgument.split(/[\\/]+/).includes('..')) {
    findings.push(finding('INPUT_PATH_TRAVERSAL', '<input>', 'generated root must not contain .. traversal segments'));
    return false;
  }
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    findings.push(finding('INPUT_MISSING', '<generated-root>', 'generated root does not exist'));
    return false;
  }
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        findings.push(finding('INPUT_SYMLINK', safeRelative(root, path), 'generated tree must not contain symlinks'));
        continue;
      }
      const real = realpathSync(path);
      if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
        findings.push(finding('INPUT_PATH_TRAVERSAL', safeRelative(root, path), 'resolved path escaped generated root'));
        continue;
      }
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
  return findings.length === 0;
}

function readSafe(root, relativePath, findings, code = 'INPUT_FILE_MISSING') {
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    findings.push(finding('INPUT_PATH_TRAVERSAL', relativePath, 'requested path escaped generated root'));
    return null;
  }
  if (!existsSync(path)) {
    findings.push(finding(code, relativePath, 'required generated file is missing'));
    return null;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    findings.push(finding('INPUT_SYMLINK', relativePath, 'required generated file must be a regular non-symlink'));
    return null;
  }
  return readFileSync(path, 'utf8');
}

function releasePolicy(evidence = {}) {
  const manifest = validateManifestSchema(readJson(RELEASE_MANIFEST_PATH));
  const privacySource = readJson(join(MOBILE_ROOT, 'app.json')).expo.ios?.privacyManifests ?? {};
  return {
    identity: manifest.identity,
    privacy: stable(privacySource),
    ios: {
      teamId: evidence.teamId ?? null,
      appGroup: evidence.appGroup ?? null,
    },
  };
}

function elementByName(root, name) {
  return root.children.find((node) => node.name === name);
}

function androidComponents(application) {
  const kinds = ['activity', 'activity-alias', 'receiver', 'service', 'provider'];
  const components = [];
  for (const kind of kinds) {
    for (const node of childElements(application, kind)) {
      components.push({
        kind,
        name: node.attrs['android:name'] ?? '',
        authorities: node.attrs['android:authorities'] ?? null,
        exported: node.attrs['android:exported'] ?? null,
        grantUriPermissions: node.attrs['android:grantUriPermissions'] ?? null,
        intentActions: sortedUnique(childElements(node, 'intent-filter').flatMap((filter) =>
          childElements(filter, 'action').map((action) => action.attrs['android:name']).filter(Boolean))),
      });
    }
  }
  return components.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
}

function maskGradle(source) {
  let result = '';
  let index = 0;
  let state = 'code';
  let quote = '';
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'line') {
      if (char === '\n') { state = 'code'; result += '\n'; } else result += ' ';
      index += 1;
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { result += '  '; index += 2; state = 'code'; }
      else { result += char === '\n' ? '\n' : ' '; index += 1; }
      continue;
    }
    if (state === 'string') {
      if (char === '\\') { result += '  '; index += 2; continue; }
      if (char === quote) { result += char; state = 'code'; } else result += char === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') { result += '  '; index += 2; state = 'line'; continue; }
    if (char === '/' && next === '*') { result += '  '; index += 2; state = 'block'; continue; }
    if (char === '"' || char === "'") { quote = char; state = 'string'; result += char; index += 1; continue; }
    result += char;
    index += 1;
  }
  return result;
}

function findGradleBlock(source, name, start = 0, end = source.length) {
  const masked = maskGradle(source);
  const token = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'g');
  token.lastIndex = start;
  let match;
  while ((match = token.exec(masked)) && match.index < end) {
    let open = match.index + match[0].length;
    while (/\s/.test(masked[open] ?? '')) open += 1;
    if (masked[open] !== '{') continue;
    let depth = 1;
    for (let index = open + 1; index < end; index += 1) {
      if (masked[index] === '{') depth += 1;
      else if (masked[index] === '}') depth -= 1;
      if (depth === 0) return { start: match.index, open, close: index, text: source.slice(open + 1, index) };
    }
  }
  return null;
}

function gradleTokens(text) {
  const masked = maskGradle(text);
  return masked.match(/[A-Za-z_][A-Za-z0-9_.]*|true|false|=|\{|\}|\(|\)|[^\s]/g) ?? [];
}

function gradleAssignment(blockText, key) {
  const tokens = gradleTokens(blockText);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== key) continue;
    const offset = tokens[i + 1] === '=' ? 2 : 1;
    return tokens[i + offset] ?? null;
  }
  return null;
}

// Supports both Groovy assignment forms: key "value" and key = "value".
function quotedGradleValue(source, variable) {
  const masked = maskGradle(source);
  const marker = new RegExp(`\\b${variable}\\b\\s*(?:=\\s*)?(["'])`, 'g');
  const match = marker.exec(masked);
  if (!match) return null;
  const quoteIndex = match.index + match[0].length - 1;
  const end = source.indexOf(source[quoteIndex], quoteIndex + 1);
  return end < 0 ? null : source.slice(quoteIndex + 1, end);
}

function parseAndroid(root, profile, policy, findings) {
  const manifestPath = 'android/app/src/main/AndroidManifest.xml';
  const gradlePath = 'android/app/build.gradle';
  const manifestText = readSafe(root, manifestPath, findings);
  const gradleText = readSafe(root, gradlePath, findings);
  if (!manifestText || !gradleText) return {};
  let manifest;
  try { manifest = parseXml(manifestText, manifestPath); }
  catch (error) { findings.push(finding('ANDROID_MANIFEST_PARSE', manifestPath, error.message)); return {}; }
  if (manifest.name !== 'manifest') {
    findings.push(finding('ANDROID_MANIFEST_PARSE', manifestPath, 'root element must be manifest'));
    return {};
  }
  const application = elementByName(manifest, 'application');
  if (!application) {
    findings.push(finding('ANDROID_APPLICATION_MISSING', manifestPath, 'manifest application is missing'));
    return {};
  }
  const permissions = sortedUnique(childElements(manifest, 'uses-permission')
    .filter((node) => node.attrs['tools:node'] !== 'remove')
    .map((node) => node.attrs['android:name']).filter(Boolean));
  for (const permission of permissions) {
    if (permission === INSTALL_PERMISSION && profile === 'store') {
      findings.push(finding('ANDROID_STORE_INSTALL_PERMISSION', manifestPath, 'Store profile must not request install/update permission'));
    } else if (permission === INSTALL_PERMISSION && profile !== 'enterprise') {
      findings.push(finding('ANDROID_PERMISSION_NOT_APPROVED', manifestPath, `${permission} is not approved for this profile`));
    } else if (permission !== INSTALL_PERMISSION && !APPROVED_ANDROID_PERMISSIONS.has(permission)) {
      findings.push(finding(
        DANGEROUS_ANDROID_PERMISSIONS.has(permission) ? 'ANDROID_DANGEROUS_PERMISSION' : 'ANDROID_PERMISSION_NOT_APPROVED',
        manifestPath,
        `${permission} is not approved`,
      ));
    }
  }
  if (profile === 'enterprise' && !permissions.includes(INSTALL_PERMISSION)) {
    findings.push(finding('ANDROID_ENTERPRISE_INSTALL_PERMISSION_MISSING', manifestPath, 'Enterprise updater profile requires install permission'));
  }
  if (application.attrs['android:debuggable'] === 'true') {
    findings.push(finding('ANDROID_DEBUGGABLE_RELEASE', manifestPath, 'release application must not be debuggable'));
  }
  if (application.attrs['android:usesCleartextTraffic'] !== 'false') {
    findings.push(finding('ANDROID_CLEARTEXT_ENABLED', manifestPath, 'production manifest must explicitly disable cleartext traffic'));
  }
  if (application.attrs['android:allowBackup'] !== 'false') {
    findings.push(finding('ANDROID_BACKUP_ENABLED', manifestPath, 'production manifest must explicitly disable backup'));
  }
  if (application.attrs['android:networkSecurityConfig']) {
    findings.push(finding('ANDROID_NETWORK_SECURITY_UNEXPECTED', manifestPath, 'production manifest must not reference an unreviewed network security config'));
  }
  const components = androidComponents(application);
  for (const component of components) {
    if (component.exported === 'true' && !(component.kind === 'activity' && component.name === '.MainActivity')) {
      findings.push(finding('ANDROID_EXPORTED_COMPONENT_UNEXPECTED', manifestPath, `unexpected exported ${component.kind} ${component.name}`));
    }
    if (component.kind === 'provider' && /FileProvider/i.test(component.name)) {
      const expectedAuthorities = `${policy.identity.androidPackage}.fileprovider`;
      if (component.grantUriPermissions !== 'true' || component.exported !== 'false' || component.authorities !== expectedAuthorities) {
        findings.push(finding('ANDROID_FILE_PROVIDER_OVERBROAD', manifestPath, `FileProvider ${component.name} must use ${expectedAuthorities}, remain non-exported, and grant only URI access`));
      }
    }
  }
  const backupFiles = [
    `android/app/src/main/res/xml/${FULL_BACKUP_RULES_RESOURCE}.xml`,
    `android/app/src/main/res/xml/${DATA_EXTRACTION_RULES_RESOURCE}.xml`,
  ];
  const backupRules = [];
  for (const path of backupFiles) {
    const text = readSafe(root, path, findings);
    if (!text) continue;
    try {
      const xml = parseXml(text, path);
      const rules = [];
      const walk = (node, scope = xml.name) => {
        const nextScope = ['cloud-backup', 'device-transfer'].includes(node.name) ? node.name : scope;
        if (node.name === 'include') findings.push(finding('ANDROID_BACKUP_RULE_OVERBROAD', path, 'backup rules must be deny-only'));
        if (node.name === 'exclude') rules.push({ scope: nextScope, ...stable(node.attrs) });
        for (const child of node.children) walk(child, nextScope);
      };
      walk(xml);
      const scopes = Object.entries(Object.groupBy(rules, (rule) => rule.scope)).sort(([a], [b]) => a.localeCompare(b)).map(([scope, entries]) => ({
        scope,
        excludes: sortedUnique(entries.map((entry) => `${entry.domain}:${entry.path}`)),
      }));
      backupRules.push({ path, root: xml.name, scopes });
    } catch (error) {
      findings.push(finding('ANDROID_BACKUP_RULE_PARSE', path, error.message));
    }
  }
  try {
    verifyGeneratedAndroidSigningConfig(gradleText);
  } catch (error) {
    findings.push(finding('ANDROID_SIGNING_POLICY_VIOLATION', gradlePath, error instanceof Error ? error.message : String(error)));
  }
  const androidBlock = findGradleBlock(gradleText, 'android');
  const buildTypes = androidBlock && findGradleBlock(gradleText, 'buildTypes', androidBlock.open + 1, androidBlock.close);
  const releaseBlock = buildTypes && findGradleBlock(gradleText, 'release', buildTypes.open + 1, buildTypes.close);
  const signingConfigs = androidBlock && findGradleBlock(gradleText, 'signingConfigs', androidBlock.open + 1, androidBlock.close);
  const releaseSigning = signingConfigs && findGradleBlock(gradleText, 'release', signingConfigs.open + 1, signingConfigs.close);
  if (!releaseBlock || !releaseSigning) {
    findings.push(finding('ANDROID_RELEASE_BUILD_CONFIG_MISSING', gradlePath, 'release buildType and signingConfig are required'));
  }
  const signingAssignment = releaseBlock ? gradleAssignment(releaseBlock.text, 'signingConfig') : null;
  if (signingAssignment?.includes('signingConfigs.debug')) {
    findings.push(finding('ANDROID_RELEASE_DEBUG_SIGNER', gradlePath, 'release buildType must not use debug signer'));
  } else if (!signingAssignment?.includes('signingConfigs.release')) {
    findings.push(finding('ANDROID_RELEASE_SIGNER_MISSING', gradlePath, 'release buildType must use signingConfigs.release'));
  }
  const releaseDebuggable = releaseBlock ? gradleAssignment(releaseBlock.text, 'debuggable') : null;
  if (releaseDebuggable?.startsWith('true')) {
    findings.push(finding('ANDROID_DEBUGGABLE_RELEASE', gradlePath, 'release buildType must not be debuggable'));
  }
  const distribution = quotedGradleValue(gradleText, 'agentSaasDistribution');
  const artifactType = quotedGradleValue(gradleText, 'agentSaasArtifactType');
  const expectedArtifact = profile === 'store' ? 'aab' : 'apk';
  if (distribution !== profile || artifactType !== expectedArtifact) {
    findings.push(finding('ANDROID_DISTRIBUTION_CONTRACT_MISMATCH', gradlePath, `expected ${profile}/${expectedArtifact}, got ${distribution ?? 'missing'}/${artifactType ?? 'missing'}`));
  }
  const namespace = androidBlock ? quotedGradleValue(androidBlock.text, 'namespace') : null;
  const defaultConfig = androidBlock && findGradleBlock(gradleText, 'defaultConfig', androidBlock.open + 1, androidBlock.close);
  const applicationId = defaultConfig ? quotedGradleValue(defaultConfig.text, 'applicationId') : null;
  if (applicationId !== policy.identity.androidPackage || namespace !== policy.identity.androidPackage) {
    findings.push(finding('ANDROID_PACKAGE_MISMATCH', gradlePath, 'namespace/applicationId do not match release-manifest identity'));
  }
  return stable({
    package: applicationId,
    namespace,
    permissions,
    application: {
      allowBackup: application.attrs['android:allowBackup'] ?? null,
      debuggable: application.attrs['android:debuggable'] ?? null,
      fullBackupContent: application.attrs['android:fullBackupContent'] ?? null,
      dataExtractionRules: application.attrs['android:dataExtractionRules'] ?? null,
      networkSecurityConfig: application.attrs['android:networkSecurityConfig'] ?? null,
      usesCleartextTraffic: application.attrs['android:usesCleartextTraffic'] ?? null,
    },
    components,
    backupRules,
    gradle: {
      artifactType,
      buildTypes: { release: { debuggable: releaseDebuggable, signingConfig: signingAssignment } },
      distribution,
      flavors: profile,
      signingConfigs: { release: Boolean(releaseSigning) },
    },
  });
}

function findFiles(root, predicate) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && predicate(path)) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

function normalizeUrlSchemes(info) {
  return sortedUnique((info.CFBundleURLTypes ?? []).flatMap((entry) => entry.CFBundleURLSchemes ?? []));
}

function pbxAssignments(source, key) {
  const values = [];
  for (const sourceLine of source.split('\n')) {
    const line = sourceLine.split('//')[0].trim();
    const separator = line.indexOf('=');
    if (separator < 0 || line.slice(0, separator).trim() !== key) continue;
    values.push(line.slice(separator + 1).replace(/;\s*$/, '').trim().replace(/^"|"$/g, ''));
  }
  return sortedUnique(values);
}

function parseIos(root, policy, evidence, findings, releaseProfile) {
  const iosRoot = join(root, 'ios');
  if (!existsSync(iosRoot)) {
    findings.push(finding('INPUT_FILE_MISSING', 'ios', 'generated iOS directory is missing'));
    return {};
  }
  const projectDirectories = readdirSync(iosRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && extname(entry.name) === '.xcodeproj');
  if (projectDirectories.length !== 1) {
    findings.push(finding('IOS_PROJECT_COUNT', 'ios', 'expected exactly one generated .xcodeproj'));
    return {};
  }
  const projectName = basename(projectDirectories[0].name, '.xcodeproj');
  const appRoot = join(iosRoot, projectName);
  const infoPath = `ios/${projectName}/Info.plist`;
  const pbxPath = `ios/${projectDirectories[0].name}/project.pbxproj`;
  const infoText = readSafe(root, infoPath, findings);
  const pbxText = readSafe(root, pbxPath, findings);
  if (!infoText || !pbxText) return {};
  let info;
  try { info = parsePlist(infoText, infoPath); }
  catch (error) { findings.push(finding('IOS_INFO_PLIST_PARSE', infoPath, error.message)); return {}; }
  const bundleIdentifiers = pbxAssignments(pbxText, 'PRODUCT_BUNDLE_IDENTIFIER');
  const developmentTeams = pbxAssignments(pbxText, 'DEVELOPMENT_TEAM');
  if (!bundleIdentifiers.includes(policy.identity.iosBundleIdentifier) ||
      bundleIdentifiers.some((value) => !value.startsWith(`${policy.identity.iosBundleIdentifier}`))) {
    findings.push(finding('IOS_BUNDLE_IDENTIFIER_MISMATCH', pbxPath, 'Xcode target bundle identifiers do not match release-manifest identity'));
  }
  if (evidence.teamId && (developmentTeams.length !== 1 || developmentTeams[0] !== evidence.teamId)) {
    findings.push(finding('IOS_TEAM_IDENTIFIER_MISMATCH', pbxPath, 'generated Xcode team does not match supplied evidence'));
  }
  const expectedScheme = policy.identity.scheme;
  const schemes = normalizeUrlSchemes(info);
  const approvedSchemes = [expectedScheme, policy.identity.iosBundleIdentifier].sort();
  if (JSON.stringify(schemes) !== JSON.stringify(approvedSchemes)) {
    findings.push(finding('IOS_URL_SCHEME_MISMATCH', infoPath, `URL schemes must be exactly ${approvedSchemes.join(', ')}`));
  }
  const ats = info.NSAppTransportSecurity ?? {};
  if (ats.NSAllowsArbitraryLoads === true || ats.NSAllowsArbitraryLoadsInWebContent === true || ats.NSAllowsLocalNetworking === true) {
    findings.push(finding('IOS_ATS_ARBITRARY_LOADS', infoPath, 'production Info.plist must not allow arbitrary/local loads'));
  }
  if (Object.keys(ats).some((key) => /ExceptionDomains|ArbitraryLoads/.test(key))) {
    findings.push(finding('IOS_ATS_EXCEPTION_UNAPPROVED', infoPath, 'production ATS exceptions are not approved'));
  }
  const backgroundModes = sortedUnique(info.UIBackgroundModes ?? []);
  if (backgroundModes.length) findings.push(finding('IOS_BACKGROUND_MODE_UNAPPROVED', infoPath, `unapproved background modes: ${backgroundModes.join(', ')}`));
  for (const key of IOS_LOCATION_KEYS) {
    if (Object.hasOwn(info, key)) findings.push(finding(key.includes('Always') ? 'IOS_USAGE_LOCATION_ALWAYS' : 'IOS_USAGE_LOCATION_UNAPPROVED', infoPath, `${key} is not approved`));
  }
  for (const [key, expected] of Object.entries(APPROVED_IOS_USAGE)) {
    if (info[key] !== expected) findings.push(finding('IOS_USAGE_DESCRIPTION_MISMATCH', infoPath, `${key} is missing or differs from approved purpose`));
  }
  const usageKeys = Object.keys(info).filter((key) => /^NS.*UsageDescription$/.test(key));
  for (const key of usageKeys) {
    if (!Object.hasOwn(APPROVED_IOS_USAGE, key) && !IOS_LOCATION_KEYS.includes(key)) {
      findings.push(finding('IOS_USAGE_DESCRIPTION_UNAPPROVED', infoPath, `${key} is not approved`));
    }
  }
  const entitlementPaths = findFiles(iosRoot, (path) => path.endsWith('.entitlements'));
  if (!entitlementPaths.length) findings.push(finding('IOS_ENTITLEMENTS_MISSING', `ios/${projectName}`, 'generated entitlements are missing'));
  const entitlements = [];
  for (const path of entitlementPaths) {
    const rel = safeRelative(root, path);
    try {
      const parsed = parsePlist(readFileSync(path, 'utf8'), rel);
      for (const key of Object.keys(parsed)) {
        if (!APPROVED_ENTITLEMENTS.has(key)) findings.push(finding('IOS_ENTITLEMENT_UNAPPROVED', rel, `${key} is not approved`));
      }
      entitlements.push({ path: rel, values: stable(parsed) });
    } catch (error) {
      findings.push(finding('IOS_ENTITLEMENTS_PARSE', rel, error.message));
    }
  }
  // 推送 entitlement：必须存在且取值与 release profile 严格一致，
  // 防止把 sandbox 令牌打进生产包（反之则生产设备收不到任何通知）。
  const expectedAps = expectedApsEnvironment(releaseProfile);
  const apsEntries = entitlements.filter((entry) => Object.hasOwn(entry.values, APS_ENVIRONMENT_KEY));
  if (entitlementPaths.length && !apsEntries.length) {
    findings.push(finding('IOS_APS_ENVIRONMENT_MISMATCH', `ios/${projectName}`, `${APS_ENVIRONMENT_KEY} is missing; expected ${expectedAps}`));
  }
  for (const entry of apsEntries) {
    if (entry.values[APS_ENVIRONMENT_KEY] !== expectedAps) {
      findings.push(finding('IOS_APS_ENVIRONMENT_MISMATCH', entry.path, `${APS_ENVIRONMENT_KEY} must be ${expectedAps}`));
    }
  }
  const groupSets = entitlements.map((entry) => entry.values['com.apple.security.application-groups']).filter(Array.isArray);
  const keychainSets = entitlements.map((entry) => entry.values['keychain-access-groups']).filter(Array.isArray);
  const expectedGroup = evidence.appGroup ?? policy.ios.appGroup;
  if (!expectedGroup) {
    findings.push(finding('IOS_APP_GROUP_EVIDENCE_MISSING', '<evidence>', 'expected app group must be supplied; production values are never guessed'));
  } else if (!groupSets.length || groupSets.some((values) => !values.includes(expectedGroup))) {
    findings.push(finding('IOS_APP_GROUP_MISMATCH', 'ios', 'main/extension app groups do not match approved evidence'));
  }
  if (expectedGroup && keychainSets.some((values) => !values.some((value) => value.endsWith(expectedGroup)))) {
    findings.push(finding('IOS_KEYCHAIN_GROUP_MISMATCH', 'ios', 'when present, keychain groups must match the approved app group'));
  }
  const privacyPaths = findFiles(iosRoot, (path) => basename(path) === 'PrivacyInfo.xcprivacy');
  if (!privacyPaths.length) findings.push(finding('IOS_PRIVACY_MANIFEST_MISSING', `ios/${projectName}`, 'PrivacyInfo.xcprivacy is required'));
  // Normalize plist defaults while preserving every security-relevant privacy value.
  const privacy = [];
  for (const path of privacyPaths) {
    const rel = safeRelative(root, path);
    try {
      const rawPrivacy = stable(parsePlist(readFileSync(path, 'utf8'), rel));
      const privacyKeys = [
        'NSPrivacyAccessedAPITypes',
        'NSPrivacyCollectedDataTypes',
        'NSPrivacyTracking',
        'NSPrivacyTrackingDomains',
      ];
      const unexpectedPrivacyKeys = Object.keys(rawPrivacy).filter((key) => !privacyKeys.includes(key));
      if (unexpectedPrivacyKeys.length) {
        findings.push(finding('IOS_PRIVACY_MANIFEST_EXTRA_OR_MISMATCH', rel, `unexpected PrivacyInfo keys: ${unexpectedPrivacyKeys.join(', ')}`));
      }
      const parsed = stable({
        NSPrivacyAccessedAPITypes: rawPrivacy.NSPrivacyAccessedAPITypes ?? [],
        NSPrivacyCollectedDataTypes: rawPrivacy.NSPrivacyCollectedDataTypes ?? [],
        NSPrivacyTracking: rawPrivacy.NSPrivacyTracking ?? false,
        NSPrivacyTrackingDomains: rawPrivacy.NSPrivacyTrackingDomains ?? [],
      });
      const expected = policy.privacy;
      const accessed = parsed.NSPrivacyAccessedAPITypes;
      const expectedAccessed = expected.NSPrivacyAccessedAPITypes ?? [];
      for (const expectedEntry of expectedAccessed) {
        const actualEntry = accessed.find((entry) => entry.NSPrivacyAccessedAPIType === expectedEntry.NSPrivacyAccessedAPIType);
        if (!actualEntry) {
          findings.push(finding('IOS_PRIVACY_REASON_MISSING', rel, `missing ${expectedEntry.NSPrivacyAccessedAPIType}`));
          continue;
        }
        const missingReasons = expectedEntry.NSPrivacyAccessedAPITypeReasons.filter((reason) => !actualEntry.NSPrivacyAccessedAPITypeReasons?.includes(reason));
        if (missingReasons.length) findings.push(finding('IOS_PRIVACY_REASON_MISSING', rel, `missing approved reason ${missingReasons.join(', ')}`));
      }
      if (JSON.stringify(stable(parsed)) !== JSON.stringify(stable(expected))) {
        findings.push(finding('IOS_PRIVACY_MANIFEST_EXTRA_OR_MISMATCH', rel, 'PrivacyInfo must exactly match the reviewed app.json privacy manifest'));
      }
      privacy.push({ path: rel, values: parsed });
    } catch (error) {
      findings.push(finding('IOS_PRIVACY_MANIFEST_PARSE', rel, error.message));
    }
  }
  const normalizedEntitlements = entitlements.map((entry) => ({
    path: entry.path.replace(projectName, '<app>'),
    values: Object.fromEntries(Object.entries(entry.values).map(([key, value]) => [key, ENTITLEMENT_VALUE_KEYS.has(key) ? value : value])),
  }));
  return stable({
    bundleIdentifier: policy.identity.iosBundleIdentifier,
    info: {
      backgroundModes,
      bundleIdentifierValue: info.CFBundleIdentifier ?? null,
      transportSecurity: ats,
      urlSchemes: schemes,
      usageDescriptions: Object.fromEntries([...Object.keys(APPROVED_IOS_USAGE), ...usageKeys].sort().filter((key, index, values) => values.indexOf(key) === index).map((key) => [key, info[key] ?? null])),
    },
    entitlements: normalizedEntitlements,
    privacy: privacy.map((entry) => ({ path: entry.path.replace(projectName, '<app>'), values: entry.values })),
    xcode: { bundleIdentifiers, developmentTeams },
  });
}

function diffValues(expected, actual, path = '$', output = []) {
  if (output.length >= 80) return output;
  if (Object.is(expected, actual)) return output;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i += 1) diffValues(expected[i], actual[i], `${path}[${i}]`, output);
    return output;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object' && !Array.isArray(expected) && !Array.isArray(actual)) {
    for (const key of sortedUnique([...Object.keys(expected), ...Object.keys(actual)])) diffValues(expected[key], actual[key], `${path}.${key}`, output);
    return output;
  }
  output.push({ path, expected: expected === undefined ? '<missing>' : expected, actual: actual === undefined ? '<missing>' : actual });
  return output;
}

export function goldenPath(profile) {
  return join(GOLDEN_ROOT, `${profile}.json`);
}

export function checkNativeTree(options) {
  const profile = options.profile;
  if (!PROFILES.includes(profile)) throw new Error(`profile must be one of ${PROFILES.join(', ')}`);
  // 原生门禁只审计「按某个 release profile 生成的树」；调用方（prebuild gate）始终生成 production。
  const releaseProfile = options.releaseProfile ?? 'production';
  const rootArgument = options.root;
  const root = resolve(rootArgument);
  const findings = [];
  const evidence = {
    classification: options.evidence?.classification ?? 'release',
    releaseEvidence: options.evidence?.classification !== 'test-fixture',
    gaps: options.evidence?.classification === 'test-fixture'
      ? ['fixture Apple team/app-group', 'no provisioning profile', 'no release keystore/signature']
      : [],
    teamId: options.evidence?.teamId ?? null,
    appGroup: options.evidence?.appGroup ?? null,
  };
  let normalized = {};
  if (assertSafeTree(root, rootArgument, findings)) {
    const policy = releasePolicy(evidence);
    normalized = profile === 'ios'
      ? { schemaVersion: 1, profile, ios: parseIos(root, policy, evidence, findings, releaseProfile) }
      : { schemaVersion: 1, profile, android: parseAndroid(root, profile, policy, findings) };
  }
  normalized = stable(normalized);
  let golden = { checked: options.compareGolden !== false, drift: [], path: `native-policy/goldens/${profile}.json` };
  if (options.compareGolden !== false && findings.length === 0) {
    const path = options.golden ?? goldenPath(profile);
    if (!existsSync(path)) {
      findings.push(finding('GOLDEN_MISSING', golden.path, 'reviewed golden is missing'));
    } else {
      const expected = stable(JSON.parse(readFileSync(path, 'utf8')));
      golden.drift = diffValues(expected, normalized);
      if (golden.drift.length) findings.push(finding('GOLDEN_DRIFT', golden.path, `normalized generated tree differs at ${golden.drift.length} bounded path(s)`));
    }
  }
  const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const correlationId = `m60-03-${profile}-${digest.slice(0, 12)}`;
  const result = stable({
    schemaVersion: 1,
    correlationId,
    profile,
    ok: findings.length === 0,
    evidence,
    input: { root: '<generated-root>' },
    summary: { errors: findings.filter((entry) => entry.severity === 'error').length, normalizedSha256: digest },
    findings,
    golden,
    normalized,
  });
  if (options.jsonPath) writeFileSync(options.jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function updateGolden(profile, normalized) {
  if (process.env.M60_03_UPDATE_GOLDEN !== '1') throw new Error('golden update requires M60_03_UPDATE_GOLDEN=1 explicit review intent');
  writeFileSync(goldenPath(profile), `${JSON.stringify(stable(normalized), null, 2)}\n`);
}

export function humanSummary(result) {
  const state = result.ok ? 'PASS' : 'FAIL';
  const evidence = result.evidence.releaseEvidence ? 'release-evidence' : 'non-release-evidence(test-fixture)';
  const lines = [`M60-03 ${state} profile=${result.profile} correlation=${result.correlationId} evidence=${evidence}`];
  for (const entry of result.findings) lines.push(`- ${entry.code} ${entry.path}: ${entry.message}`);
  if (result.evidence.gaps.length) lines.push(`- evidence gaps: ${result.evidence.gaps.join('; ')}`);
  return lines.join('\n');
}
