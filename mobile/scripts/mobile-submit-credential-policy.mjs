import { pathToFileURL } from 'node:url';

function requireValue(value, name) {
  if (!value) throw new Error(`${name} is missing`);
}

function requireCredentialFreeHttps(value, name) {
  requireValue(value, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${name} must be credential-free HTTPS`);
  }
}

/** M60-04 validates only the credentials used by the selected submit profile. */
export function validateMobileSubmitCredentials(profile, env) {
  switch (profile) {
    case 'ios-store':
      requireValue(env.APP_STORE_CONNECT_API_KEY_P8, 'APP_STORE_CONNECT_API_KEY_P8');
      requireValue(env.APP_STORE_CONNECT_API_KEY_ID, 'APP_STORE_CONNECT_API_KEY_ID');
      requireValue(env.APP_STORE_CONNECT_ISSUER_ID, 'APP_STORE_CONNECT_ISSUER_ID');
      return;
    case 'android-store':
      requireValue(env.ANDROID_PLAY_SERVICE_ACCOUNT_JSON, 'ANDROID_PLAY_SERVICE_ACCOUNT_JSON');
      return;
    case 'android-enterprise':
      requireValue(env.ENTERPRISE_MDM_ROBOT_TOKEN, 'ENTERPRISE_MDM_ROBOT_TOKEN');
      requireCredentialFreeHttps(env.MOBILE_ENTERPRISE_SUBMIT_ENDPOINT, 'MOBILE_ENTERPRISE_SUBMIT_ENDPOINT');
      return;
    default:
      throw new Error(`unsupported mobile submit profile: ${profile}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateMobileSubmitCredentials(process.argv[2], process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
