import rateLimiter from '@convex-dev/rate-limiter/test';
import workpool from '@convex-dev/workpool/test';

import schema from './component/schema.js';

import type { TestConvex } from 'convex-test';
import type { GenericSchema, SchemaDefinition } from 'convex/server';

const modules = import.meta.glob('./component/**/*.ts');

/**
 * Register the component with a `convex-test` instance.
 *
 * The component uses a rate limiter and three workpools, so this registers
 * those under the component's path too. Nested components have to be
 * registered explicitly; `convex-test` does not follow `convex.config.ts`.
 *
 * @param t The test instance, from `convexTest`.
 * @param name The name the component was mounted under in `convex.config.ts`.
 */
export function register<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(t: TestConvex<Schema>, name: string = 'postshiba') {
  const generic = t as unknown as TestConvex<
    SchemaDefinition<GenericSchema, boolean>
  >;
  generic.registerComponent(name, schema, modules);
  rateLimiter.register(generic, `${name}/rateLimiter`);
  workpool.register(generic, `${name}/transactionalPool`);
  workpool.register(generic, `${name}/bulkPool`);
  workpool.register(generic, `${name}/callbackPool`);
}

export default { register, schema, modules };
