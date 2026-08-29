const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { describe, it } = require('node:test');
const {
  RELEASE_SIGNING_ENV,
  applyAndroidSigningConfig,
  verifyGeneratedAndroidSigningConfig,
} = require('./withAndroidSigningConfig');

const EXPO_GRADLE_FIXTURE = `plugins {
    id 'com.android.application'
}

android {
    namespace 'com.example.fixture'
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Expo/React Native template default that M00-02 must replace.
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}

dependencies {
    implementation("com.facebook.react:react-android")
}
`;

function withTemporarySigningEnvironment(values, callback) {
  const previous = new Map();
  for (const name of RELEASE_SIGNING_ENV) {
    previous.set(name, process.env[name]);
    if (Object.hasOwn(values, name)) {
      process.env[name] = values[name];
    } else {
      delete process.env[name];
    }
  }

  try {
    return callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('M00-02 Android release signing config plugin', () => {
  it("replaces Expo's existing debug release signer instead of returning early", () => {
    const output = applyAndroidSigningConfig(EXPO_GRADLE_FIXTURE);

    assert.equal(verifyGeneratedAndroidSigningConfig(output), true);
    const buildTypesText = output.slice(
      output.indexOf('buildTypes'),
      output.indexOf('dependencies'),
    );
    assert.match(buildTypesText, /signingConfig signingConfigs\.release/);
    assert.doesNotMatch(
      buildTypesText.match(/release\s*\{[\s\S]*?\n\s{8}\}/)?.[0] ?? '',
      /signingConfigs\.debug/,
    );
  });

  it('writes environment lookups, never current secret values, into Gradle', () => {
    const sentinels = Object.fromEntries(
      RELEASE_SIGNING_ENV.map((name, index) => [name, `synthetic-value-never-write-${index}`]),
    );

    const output = withTemporarySigningEnvironment(sentinels, () =>
      applyAndroidSigningConfig(EXPO_GRADLE_FIXTURE),
    );

    for (const [name, sentinel] of Object.entries(sentinels)) {
      assert.match(output, new RegExp(`System\\.getenv\\("${name}"\\)`));
      assert.doesNotMatch(output, new RegExp(sentinel));
    }
    const releaseSigningText = output.slice(
      output.indexOf('signingConfigs'),
      output.indexOf('buildTypes'),
    );
    assert.doesNotMatch(
      releaseSigningText,
      /(?:storePassword|keyPassword|keyAlias)\s+['"][^'"]+['"]/,
    );
  });

  it('allows credential-free prebuild transformation but injects a release-task failure gate', () => {
    const output = withTemporarySigningEnvironment({}, () =>
      applyAndroidSigningConfig(EXPO_GRADLE_FIXTURE),
    );

    assert.equal(verifyGeneratedAndroidSigningConfig(output), true);
    assert.match(output, /gradle\.taskGraph\.whenReady/);
    assert.match(output, /task\.name[\s\S]*?contains\("release"\)/);
    assert.match(output, /missingNames[\s\S]*?throw new GradleException/);
    assert.match(output, /validateAndroidReleaseSigningCredentials/);
  });

  it('is idempotent across repeated config-plugin evaluation', () => {
    const once = applyAndroidSigningConfig(EXPO_GRADLE_FIXTURE);
    const twice = applyAndroidSigningConfig(once);

    assert.equal(twice, once);
    assert.equal(twice.split('M00-02: Android release signing policy (begin)').length - 1, 1);
  });

  it('static verification rejects a debug signer, a release literal, or a missing gate', () => {
    const output = applyAndroidSigningConfig(EXPO_GRADLE_FIXTURE);

    assert.throws(
      () =>
        verifyGeneratedAndroidSigningConfig(
          output.replace(
            'signingConfig signingConfigs.release',
            'signingConfig signingConfigs.debug',
          ),
        ),
      /signingConfigs\.debug/,
    );
    assert.throws(
      () =>
        verifyGeneratedAndroidSigningConfig(
          output.replace(
            'storePassword androidReleaseSigningEnv["ANDROID_RELEASE_STORE_PASSWORD"]',
            'storePassword "synthetic-test-only"',
          ),
        ),
      /credential literal|exclusively from the environment map/,
    );
    assert.throws(
      () =>
        verifyGeneratedAndroidSigningConfig(
          output.replace('gradle.taskGraph.whenReady', 'gradle.taskGraph.whenReadyDisabled'),
        ),
      /fail-closed validation/,
    );
  });

  it('plugin source contains no literal store/key password assignment or fixed keystore fallback', () => {
    const source = readFileSync(require.resolve('./withAndroidSigningConfig'), 'utf8');

    assert.doesNotMatch(source, /(?:storePassword|keyPassword)\s+['"][^'"]+['"]/);
    assert.doesNotMatch(source, /certs[\\/]release\.keystore/);
  });
});
