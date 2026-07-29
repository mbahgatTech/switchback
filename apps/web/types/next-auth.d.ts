import type { DefaultSession } from 'next-auth';

/**
 * Adds `user.id` to the session type.
 *
 * The `session` callback in `auth.ts` puts it there at runtime; Auth.js cannot know that,
 * so without this augmentation every `session.user.id` read is a type error. Declared
 * once, globally, rather than cast at each call site.
 */
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

export {};
