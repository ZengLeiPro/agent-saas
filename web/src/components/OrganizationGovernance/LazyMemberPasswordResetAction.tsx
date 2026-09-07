import { lazy, Suspense, type ComponentProps } from 'react';

const MemberPasswordResetAction = lazy(async () => {
  const module = await import('./MemberPasswordResetAction');
  return { default: module.MemberPasswordResetAction };
});

export function LazyMemberPasswordResetAction(props: ComponentProps<typeof MemberPasswordResetAction>) {
  return <Suspense fallback={null}><MemberPasswordResetAction {...props} /></Suspense>;
}
