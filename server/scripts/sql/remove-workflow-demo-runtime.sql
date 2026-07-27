-- 移除已退役的 Workflow Demo 专用运行时表。
--
-- 重要：本脚本不会由应用自动执行。生产环境执行前必须先确认不存在仍需保留的
-- 公开回放/分享链接，并完成必要的数据导出。默认表前缀为 runtime；如果部署时
-- 使用了其他 tablePrefix，请同步替换下列表名。

BEGIN;

DROP TABLE IF EXISTS runtime_workflow_demo_publications;
DROP TABLE IF EXISTS runtime_workflow_demo_reviews;
DROP TABLE IF EXISTS runtime_workflow_demo_replays;
DROP TABLE IF EXISTS runtime_workflow_demo_continuations;
DROP TABLE IF EXISTS runtime_workflow_demo_waits;
DROP TABLE IF EXISTS runtime_workflow_demo_mutations;
DROP TABLE IF EXISTS runtime_workflow_demo_events;
DROP TABLE IF EXISTS runtime_workflow_demo_objects;
DROP TABLE IF EXISTS runtime_workflow_demo_runs;

COMMIT;
