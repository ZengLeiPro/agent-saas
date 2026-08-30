import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeMocks = vi.hoisted(() => ({
  requestRecordingPermissionsAsync: vi.fn(),
  getCameraPermissionsAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
}));

vi.mock('expo-audio', () => ({
  AudioModule: {
    requestRecordingPermissionsAsync: nativeMocks.requestRecordingPermissionsAsync,
  },
}));

vi.mock('react-native', () => ({ Linking: { openSettings: vi.fn() } }));

vi.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: nativeMocks.getCameraPermissionsAsync,
  requestCameraPermissionsAsync: nativeMocks.requestCameraPermissionsAsync,
  launchCameraAsync: nativeMocks.launchCameraAsync,
  launchImageLibraryAsync: nativeMocks.launchImageLibraryAsync,
}));

import {
  launchCameraForUserAction,
  launchPhotoLibraryForUserAction,
  requestMicrophoneForUserAction,
} from './jitMediaPermissions';

describe('M10-05 JIT media permission boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has no native permission or picker side effect on module import', () => {
    expect(nativeMocks.requestRecordingPermissionsAsync).not.toHaveBeenCalled();
    expect(nativeMocks.getCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(nativeMocks.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(nativeMocks.launchCameraAsync).not.toHaveBeenCalled();
    expect(nativeMocks.launchImageLibraryAsync).not.toHaveBeenCalled();
  });

  it('requests microphone only when the voice user-action function runs', async () => {
    nativeMocks.requestRecordingPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });

    await expect(requestMicrophoneForUserAction()).resolves.toEqual({ granted: false, permanentlyDenied: false });
    expect(nativeMocks.requestRecordingPermissionsAsync).toHaveBeenCalledOnce();
    expect(nativeMocks.launchCameraAsync).not.toHaveBeenCalled();
    expect(nativeMocks.launchImageLibraryAsync).not.toHaveBeenCalled();
  });

  it('reports permanent microphone denial for the settings fallback', async () => {
    nativeMocks.requestRecordingPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    await expect(requestMicrophoneForUserAction()).resolves.toEqual({ granted: false, permanentlyDenied: true });
  });

  it('does not launch the camera after the user denies its JIT request', async () => {
    nativeMocks.getCameraPermissionsAsync.mockResolvedValue({ granted: false });
    nativeMocks.requestCameraPermissionsAsync.mockResolvedValue({ granted: false });

    await expect(launchCameraForUserAction({ mediaTypes: ['images'] })).resolves.toBeNull();
    expect(nativeMocks.getCameraPermissionsAsync).toHaveBeenCalledOnce();
    expect(nativeMocks.requestCameraPermissionsAsync).toHaveBeenCalledOnce();
    expect(nativeMocks.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('launches camera and gallery only through their explicit user-action functions', async () => {
    const cameraResult = { canceled: true, assets: null };
    const libraryResult = { canceled: true, assets: null };
    nativeMocks.getCameraPermissionsAsync.mockResolvedValue({ granted: true });
    nativeMocks.launchCameraAsync.mockResolvedValue(cameraResult);
    nativeMocks.launchImageLibraryAsync.mockResolvedValue(libraryResult);

    await expect(launchCameraForUserAction({ mediaTypes: ['images'] })).resolves.toBe(cameraResult);
    await expect(launchPhotoLibraryForUserAction({ mediaTypes: ['images'] })).resolves.toBe(
      libraryResult,
    );
    expect(nativeMocks.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(nativeMocks.launchCameraAsync).toHaveBeenCalledOnce();
    expect(nativeMocks.launchImageLibraryAsync).toHaveBeenCalledOnce();
  });
});
