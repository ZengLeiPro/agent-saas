import { AudioModule } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';

export type PhotoLibraryLaunchOptions = Parameters<typeof ImagePicker.launchImageLibraryAsync>[0];
export type CameraLaunchOptions = Parameters<typeof ImagePicker.launchCameraAsync>[0];
export type PhotoLibraryLaunchResult = Awaited<
  ReturnType<typeof ImagePicker.launchImageLibraryAsync>
>;
export type CameraLaunchResult = Awaited<ReturnType<typeof ImagePicker.launchCameraAsync>>;

/**
 * Permission-capable native APIs live behind named user-action functions.
 * Importing this module has no permission side effect; callers invoke a function
 * only from the matching microphone/camera/gallery control.
 */
export async function requestMicrophoneForUserAction(): Promise<boolean> {
  const permission = await AudioModule.requestRecordingPermissionsAsync();
  return permission.granted;
}

export async function launchPhotoLibraryForUserAction(
  options: PhotoLibraryLaunchOptions,
): Promise<PhotoLibraryLaunchResult> {
  return ImagePicker.launchImageLibraryAsync(options);
}

export async function launchCameraForUserAction(
  options: CameraLaunchOptions,
): Promise<CameraLaunchResult | null> {
  const current = await ImagePicker.getCameraPermissionsAsync();
  const permission = current.granted ? current : await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return null;
  return ImagePicker.launchCameraAsync(options);
}
