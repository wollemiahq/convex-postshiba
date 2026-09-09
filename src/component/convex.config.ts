import rateLimiter from '@convex-dev/rate-limiter/convex.config';
import workpool from '@convex-dev/workpool/convex.config';
import { defineComponent } from 'convex/server';

const component = defineComponent('postshiba');

// One shared rate limiter holding both the transactional and the bulk bucket.
component.use(rateLimiter);

// Sends are split across two pools so a bulk campaign cannot starve a
// password reset. Webhook callbacks get their own pool so a slow callback
// cannot tie up delivery threads.
component.use(workpool, { name: 'transactionalPool' });
component.use(workpool, { name: 'bulkPool' });
component.use(workpool, { name: 'callbackPool' });

export default component;
