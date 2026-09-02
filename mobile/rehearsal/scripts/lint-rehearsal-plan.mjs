#!/usr/bin/env node
import { readFile } from 'node:fs/promises';import { validateRehearsalPlan } from './rehearsal-contract.mjs';
const result=validateRehearsalPlan(JSON.parse(await readFile(new URL('../rehearsal-plan.json',import.meta.url),'utf8')));process.stdout.write(`${JSON.stringify(result)}\n`);
