import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

type HeaderItem = NonNullable<
  ReturnType<NonNullable<NativeStackNavigationOptions['unstable_headerLeftItems']>>
>[number];

/**
 * Wrap a React element as a glass-free custom header item for iOS 26+.
 * Removes the liquid glass circular container from header buttons.
 *
 * On Android, `unstable_headerLeftItems`/`unstable_headerRightItems` are ignored,
 * so the existing `headerLeft`/`headerRight` continues to work as fallback.
 */
export function glassFree(element: React.ReactElement): HeaderItem {
  return { type: 'custom', element, hidesSharedBackground: true };
}
