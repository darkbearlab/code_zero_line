/**
 * Back-compat alias. BattleScene and existing tests import `chooseAiCommand`
 * from this module — the implementation now lives in
 * [./controllers/greedy.ts](./controllers/greedy.ts) under the named export
 * `greedyController` so it can sit alongside other strategies (lookahead etc).
 */
export { greedyController as chooseAiCommand } from './controllers/greedy';
