import { AudioModule } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import { Linking } from 'react-native';

export type PhotoLibraryLaunchOptions = Parameters<typeof ImagePicker.launchImageLibraryAsync>[0];
export type CameraLaunchOptions = Parameters<typeof ImagePicker.launchCameraAsync>[0];
export type PhotoLibraryLaunchResult = Awaited<ReturnType<typeof ImagePicker.launchImageLibraryAsync>>;
export type CameraLaunchResult = Awaited<ReturnType<typeof ImagePicker.launchCameraAsync>>;

export interface MicrophonePermissionOutcome {
  granted: boolean;
  permanentlyDenied: boolean;
}

/** Importing this module has no permission side effect. Only the microphone press invokes this. */
export async function requestMicrophoneForUserAction(): Promise<MicrophonePermissionOutcome> {
  const permission = await AudioModule.requestRecordingPermissionsAsync();
  return { granted: permission.granted, permanentlyDenied: !permission.granted && permission.canAskAgain === false };
}

export async function openAppSettingsForPermissionFallback(): Promise<void> {
  await Linking.openSettings();
}

export async function launchPhotoLibraryForUserAction(options: PhotoLibraryLaunchOptions): Promise<PhotoLibraryLaunchResult> {
  return ImagePicker.launchImageLibraryAsync(options);
}

export async function launchCameraForUserAction(options: CameraLaunchOptions): Promise<CameraLaunchResult | null> {
  const current = await ImagePicker.getCameraPermissionsAsync();
  const permission = current.granted ? current : await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return null;
  return ImagePicker.launchCameraAsync(options);
}
