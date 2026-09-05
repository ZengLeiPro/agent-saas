#!/usr/bin/env node
import { USAGE } from './index.js';

// Phase A 骨架：只打印用法并以 2 退出，表示「命令存在但功能未实现」。
console.log(USAGE);
process.exitCode = 2;
