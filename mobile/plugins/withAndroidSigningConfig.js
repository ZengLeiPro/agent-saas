const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Android release signing inputs are supplied only by the build environment.
 * The keystore must be an external file; no password, alias, or path fallback is
 * allowed in source control. Gradle validates these names only when a release
 * task is selected, so `expo prebuild --clean --no-install` remains usable for
 * static inspection without credentials.
 */
const RELEASE_SIGNING_ENV = Object.freeze([
  'ANDROID_RELEASE_KEYSTORE_PATH',
  'ANDROID_RELEASE_STORE_PASSWORD',
  'ANDROID_RELEASE_KEY_ALIAS',
  'ANDROID_RELEASE_KEY_PASSWORD',
]);

const PREFACE_START = '// M00-02: Android release signing policy (begin)';
const PREFACE_END = '// M00-02: Android release signing policy (end)';
const VALIDATION_START = '// M00-02: Android release task fail-closed gate (begin)';
const VALIDATION_END = '// M00-02: Android release task fail-closed gate (end)';
const DISTRIBUTION_START = '// M60-03: native distribution contract (begin)';
const DISTRIBUTION_END = '// M60-03: native distribution contract (end)';

const RELEASE_ENV_MAP = RELEASE_SIGNING_ENV.map(
  (name) => `    "${name}": System.getenv("${name}")`,
).join(',\n');

const RELEASE_SIGNING_PREFACE = `${PREFACE_START}
def androidReleaseSigningEnv = [
${RELEASE_ENV_MAP}
]

def validateAndroidReleaseSigning = {
    def missingNames = androidReleaseSigningEnv.findAll { name, value ->
        value == null || value.trim().isEmpty()
    }.keySet().sort()

    if (!missingNames.isEmpty()) {
        throw new GradleException(
            "Android release signing is blocked: missing required environment variables: " +
                missingNames.join(", ")
        )
    }

    def releaseKeystore = file(
        androidReleaseSigningEnv["ANDROID_RELEASE_KEYSTORE_PATH"]
    )
    if (!releaseKeystore.isFile()) {
        throw new GradleException(
            "Android release signing is blocked: ANDROID_RELEASE_KEYSTORE_PATH " +
                "does not point to a regular file"
        )
    }
}
${PREFACE_END}`;

const RELEASE_TASK_VALIDATION = `${VALIDATION_START}
tasks.register("validateAndroidReleaseSigningCredentials") {
    group = "verification"
    description = "Fail closed when Android release signing inputs are unavailable"
    doLast {
        validateAndroidReleaseSigning()
    }
}

def androidReleaseSigningProject = project
gradle.taskGraph.whenReady { graph ->
    def releaseTaskSelected = graph.allTasks.any { task ->
        task.project == androidReleaseSigningProject &&
            task.name != "validateAndroidReleaseSigningCredentials" &&
            task.name.toLowerCase(java.util.Locale.ROOT).contains("release")
    }
    if (releaseTaskSelected) {
        validateAndroidReleaseSigning()
    }
}
${VALIDATION_END}`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineStartAt(contents, index) {
  const newline = contents.lastIndexOf('\n', index - 1);
  return newline === -1 ? 0 : newline + 1;
}

function lineEndAfter(contents, index) {
  const newline = contents.indexOf('\n', index);
  return newline === -1 ? contents.length : newline + 1;
}

function lineIndentAt(contents, index) {
  const lineStart = lineStartAt(contents, index);
  const match = contents.slice(lineStart, index).match(/^\s*/);
  return match ? match[0] : '';
}

/** Find a matching Groovy brace while ignoring comments and quoted strings. */
function findMatchingBrace(contents, openBrace) {
  let depth = 0;
  let state = 'code';

  for (let index = openBrace; index < contents.length; index += 1) {
    const current = contents[index];
    const next = contents[index + 1];

    if (state === 'line-comment') {
      if (current === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote') {
      if (current === '\\') {
        index += 1;
        continue;
      }
      if (
        (state === 'single-quote' && current === "'") ||
        (state === 'double-quote' && current === '"')
      ) {
        state = 'code';
      }
      continue;
    }

    if (current === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (current === "'") {
      state = 'single-quote';
      continue;
    }
    if (current === '"') {
      state = 'double-quote';
      continue;
    }
    if (current === '{') depth += 1;
    if (current === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function findNamedBlock(contents, name, from = 0, to = contents.length) {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\{`, 'g');
  pattern.lastIndex = from;
  const match = pattern.exec(contents);
  if (!match || match.index >= to) return null;

  const openBrace = contents.indexOf('{', match.index);
  const closeBrace = findMatchingBrace(contents, openBrace);
  if (closeBrace === -1 || closeBrace >= to) return null;

  return {
    start: match.index,
    openBrace,
    closeBrace,
    end: closeBrace + 1,
  };
}

function removeManagedSection(contents, startMarker, endMarker) {
  let result = contents;
  while (true) {
    const start = result.indexOf(startMarker);
    if (start === -1) return result;
    const endMarkerIndex = result.indexOf(endMarker, start);
    if (endMarkerIndex === -1) {
      throw new Error(`Incomplete managed Gradle section: ${startMarker}`);
    }
    let end = endMarkerIndex + endMarker.length;
    if (result[end] === '\r') end += 1;
    if (result[end] === '\n') end += 1;
    result = result.slice(0, start) + result.slice(end);
  }
}

function renderReleaseSigningConfig(indent) {
  const inner = `${indent}    `;
  const nested = `${inner}    `;
  return `${indent}release {
${inner}// Values are read at Gradle runtime; never interpolate secrets here.
${inner}if (androidReleaseSigningEnv.values().every { value ->
${nested}value != null && !value.trim().isEmpty()
${inner}}) {
${nested}def releaseKeystorePath =
${nested}    androidReleaseSigningEnv["ANDROID_RELEASE_KEYSTORE_PATH"]
${nested}storeFile file(releaseKeystorePath)
${nested}storePassword androidReleaseSigningEnv["ANDROID_RELEASE_STORE_PASSWORD"]
${nested}keyAlias androidReleaseSigningEnv["ANDROID_RELEASE_KEY_ALIAS"]
${nested}keyPassword androidReleaseSigningEnv["ANDROID_RELEASE_KEY_PASSWORD"]
${inner}}
${indent}}`;
}

function replaceReleaseSigningConfig(contents) {
  const androidBlock = findNamedBlock(contents, 'android');
  if (!androidBlock) {
    throw new Error('Unable to find the Android Gradle block');
  }

  const signingConfigs = findNamedBlock(
    contents,
    'signingConfigs',
    androidBlock.openBrace + 1,
    androidBlock.closeBrace,
  );
  if (!signingConfigs) {
    throw new Error('Unable to find Android signingConfigs after Expo prebuild');
  }

  const signingIndent = lineIndentAt(contents, signingConfigs.start);
  const releaseIndent = `${signingIndent}    `;
  const managedRelease = renderReleaseSigningConfig(releaseIndent);
  const existingRelease = findNamedBlock(
    contents,
    'release',
    signingConfigs.openBrace + 1,
    signingConfigs.closeBrace,
  );

  if (existingRelease) {
    const replaceStart = lineStartAt(contents, existingRelease.start);
    const replaceEnd = lineEndAfter(contents, existingRelease.end);
    return contents.slice(0, replaceStart) + managedRelease + '\n' + contents.slice(replaceEnd);
  }

  const insertAt = lineStartAt(contents, signingConfigs.closeBrace);
  return contents.slice(0, insertAt) + managedRelease + '\n' + contents.slice(insertAt);
}

function pointReleaseBuildTypeAtReleaseSigner(contents) {
  const androidBlock = findNamedBlock(contents, 'android');
  if (!androidBlock) {
    throw new Error('Unable to find the Android Gradle block');
  }
  const buildTypes = findNamedBlock(
    contents,
    'buildTypes',
    androidBlock.openBrace + 1,
    androidBlock.closeBrace,
  );
  if (!buildTypes) {
    throw new Error('Unable to find Android buildTypes after Expo prebuild');
  }
  const releaseBuildType = findNamedBlock(
    contents,
    'release',
    buildTypes.openBrace + 1,
    buildTypes.closeBrace,
  );
  if (!releaseBuildType) {
    throw new Error('Unable to find the Android release build type');
  }

  const releaseContents = contents.slice(
    releaseBuildType.openBrace + 1,
    releaseBuildType.closeBrace,
  );
  const signingConfigPattern = /signingConfig\s+signingConfigs\.[A-Za-z_][A-Za-z0-9_]*/g;
  let nextReleaseContents;
  if (signingConfigPattern.test(releaseContents)) {
    nextReleaseContents = releaseContents.replace(
      signingConfigPattern,
      'signingConfig signingConfigs.release',
    );
  } else {
    const indent = `${lineIndentAt(contents, releaseBuildType.start)}    `;
    nextReleaseContents = `\n${indent}signingConfig signingConfigs.release${releaseContents}`;
  }

  return (
    contents.slice(0, releaseBuildType.openBrace + 1) +
    nextReleaseContents +
    contents.slice(releaseBuildType.closeBrace)
  );
}

function applyAndroidSigningConfig(inputContents) {
  let contents = removeManagedSection(inputContents, PREFACE_START, PREFACE_END);
  contents = removeManagedSection(contents, VALIDATION_START, VALIDATION_END).trimEnd();

  const androidBlock = findNamedBlock(contents, 'android');
  if (!androidBlock) {
    throw new Error('Unable to find the Android Gradle block');
  }
  const androidLineStart = lineStartAt(contents, androidBlock.start);
  const prefix = contents.slice(0, androidLineStart).trimEnd();
  contents =
    prefix +
    (prefix ? '\n\n' : '') +
    RELEASE_SIGNING_PREFACE +
    '\n\n' +
    contents.slice(androidLineStart);

  contents = replaceReleaseSigningConfig(contents);
  contents = pointReleaseBuildTypeAtReleaseSigner(contents);
  return `${contents.trimEnd()}\n\n${RELEASE_TASK_VALIDATION}\n`;
}

function countOccurrences(contents, value) {
  return contents.split(value).length - 1;
}

/** Static verification used by the repeatable clean-prebuild gate. */
function verifyGeneratedAndroidSigningConfig(contents) {
  const errors = [];
  const androidBlock = findNamedBlock(contents, 'android');
  const signingConfigs = androidBlock
    ? findNamedBlock(
        contents,
        'signingConfigs',
        androidBlock.openBrace + 1,
        androidBlock.closeBrace,
      )
    : null;
  const releaseSigning = signingConfigs
    ? findNamedBlock(contents, 'release', signingConfigs.openBrace + 1, signingConfigs.closeBrace)
    : null;
  const buildTypes = androidBlock
    ? findNamedBlock(contents, 'buildTypes', androidBlock.openBrace + 1, androidBlock.closeBrace)
    : null;
  const releaseBuildType = buildTypes
    ? findNamedBlock(contents, 'release', buildTypes.openBrace + 1, buildTypes.closeBrace)
    : null;

  if (!releaseSigning) errors.push('missing signingConfigs.release');
  if (!releaseBuildType) errors.push('missing buildTypes.release');

  const signingText = releaseSigning
    ? contents.slice(releaseSigning.start, releaseSigning.end)
    : '';
  const releaseBuildText = releaseBuildType
    ? contents.slice(releaseBuildType.start, releaseBuildType.end)
    : '';

  if (!/signingConfig\s+signingConfigs\.release\b/.test(releaseBuildText)) {
    errors.push('buildTypes.release does not use signingConfigs.release');
  }
  if (/signingConfigs\.debug\b/.test(releaseBuildText)) {
    errors.push('buildTypes.release still references signingConfigs.debug');
  }
  if (/(?:storePassword|keyPassword|keyAlias)\s+['"][^'"]+['"]/.test(signingText)) {
    errors.push('release signing contains a credential literal');
  }

  for (const name of RELEASE_SIGNING_ENV) {
    if (!contents.includes(`"${name}": System.getenv("${name}")`)) {
      errors.push(`release signing does not read ${name} from the environment`);
    }
  }
  if (!signingText.includes('storeFile file(releaseKeystorePath)')) {
    errors.push('release keystore path is not supplied by the environment map');
  }
  if (
    !signingText.includes(
      'storePassword androidReleaseSigningEnv["ANDROID_RELEASE_STORE_PASSWORD"]',
    ) ||
    !signingText.includes('keyAlias androidReleaseSigningEnv["ANDROID_RELEASE_KEY_ALIAS"]') ||
    !signingText.includes('keyPassword androidReleaseSigningEnv["ANDROID_RELEASE_KEY_PASSWORD"]')
  ) {
    errors.push('release signing values are not wired exclusively from the environment map');
  }

  if (
    !/gradle\.taskGraph\.whenReady\s*\{/.test(contents) ||
    !contents.includes('.contains("release")') ||
    !contents.includes('validateAndroidReleaseSigning()') ||
    !contents.includes('task.project == androidReleaseSigningProject') ||
    !contents.includes('throw new GradleException')
  ) {
    errors.push('release task fail-closed validation is missing');
  }
  for (const marker of [PREFACE_START, PREFACE_END, VALIDATION_START, VALIDATION_END]) {
    if (countOccurrences(contents, marker) !== 1) {
      errors.push(`managed marker must occur exactly once: ${marker}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid generated Android signing config:\n- ${errors.join('\n- ')}`);
  }
  return true;
}

function applyAndroidDistributionContract(contents, distributionConfig) {
  const distribution = distributionConfig?.flavor;
  const artifactType = distributionConfig?.artifactType;
  const expectedArtifact = distribution === 'store' ? 'aab' : distribution === 'enterprise' ? 'apk' : 'none';
  if (!['store', 'enterprise', 'unselected'].includes(distribution) || artifactType !== expectedArtifact) {
    throw new Error('[M60-03] Android distribution/artifact contract is missing or inconsistent');
  }
  const managed = `${DISTRIBUTION_START}\ndef agentSaasDistribution = "${distribution}"\ndef agentSaasArtifactType = "${artifactType}"\n${DISTRIBUTION_END}`;
  const existingPattern = new RegExp(
    `${escapeRegExp(DISTRIBUTION_START)}[\\s\\S]*?${escapeRegExp(DISTRIBUTION_END)}\\n*`,
    'g',
  );
  const withoutExisting = contents.replace(existingPattern, '').trimStart();
  return `${managed}\n\n${withoutExisting}`;
}

function withAndroidSigningConfig(config) {
  return withAppBuildGradle(config, (configWithGradle) => {
    const signingConfigured = applyAndroidSigningConfig(configWithGradle.modResults.contents);
    configWithGradle.modResults.contents = applyAndroidDistributionContract(
      signingConfigured,
      config.extra?.androidDistribution,
    );
    return configWithGradle;
  });
}

module.exports = withAndroidSigningConfig;
module.exports.RELEASE_SIGNING_ENV = RELEASE_SIGNING_ENV;
module.exports.applyAndroidDistributionContract = applyAndroidDistributionContract;
module.exports.applyAndroidSigningConfig = applyAndroidSigningConfig;
module.exports.verifyGeneratedAndroidSigningConfig = verifyGeneratedAndroidSigningConfig;
