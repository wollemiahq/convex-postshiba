import { convexTest } from 'convex-test';
import { componentsGeneric, defineSchema } from 'convex/server';
import { test } from 'vitest';

import postshiba from '../test.js';

import type { PostShibaComponent } from './index.js';

export const modules = import.meta.glob('./**/*.*s');

export const components = componentsGeneric() as unknown as {
  postshiba: PostShibaComponent;
};

/** A bare app with the component, registered through the `/test` helper. */
export const setupTest = () => {
  const t = convexTest(defineSchema({}), modules);
  postshiba.register(t, 'postshiba');
  return t;
};

export type Tester = ReturnType<typeof setupTest>;

test('setup', () => {});
