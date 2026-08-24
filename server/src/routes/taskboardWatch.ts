import type { Request, RequestHandler, Response, Router } from 'express';

import type { UserStore } from '../data/users/store.js';
import type { TaskboardIdentity, TaskboardService } from '../taskboard/types.js';
import { TaskboardExecutionUnavailableError } from '../taskboard/types.js';
import { withCreatorAvatarVersion } from './taskboardAvatar.js';

interface TaskboardWatchRouteOptions {
  service?: TaskboardService;
  userStore?: UserStore;
}

type IdentityFrom = (req: Request) => TaskboardIdentity;
type Route = (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler;

export function registerTaskboardWatchRoutes(
  router: Router,
  options: TaskboardWatchRouteOptions,
  identityFrom: IdentityFrom,
  route: Route,
): void {
  router.get('/tasks/:id', route(async (req, res) => {
    const identity = identityFrom(req);
    const task = await options.service!.getTask(identity, req.params.id);
    const watched = options.service!.isTaskWatched
      ? await options.service!.isTaskWatched(identity, req.params.id)
      : false;
    res.json({ ...withCreatorAvatarVersion(options.userStore, identity, task), watched });
  }));

  router.put('/tasks/:id/watch', route(async (req, res) => {
    if (!options.service!.setTaskWatched) throw new TaskboardExecutionUnavailableError('Task watch unavailable');
    res.json({ watched: await options.service!.setTaskWatched(identityFrom(req), req.params.id, true) });
  }));

  router.delete('/tasks/:id/watch', route(async (req, res) => {
    if (!options.service!.setTaskWatched) throw new TaskboardExecutionUnavailableError('Task watch unavailable');
    res.json({ watched: await options.service!.setTaskWatched(identityFrom(req), req.params.id, false) });
  }));
}
