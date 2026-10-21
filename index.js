'use strict';
// Scrape.ly GitHub Action: start an Actor or task run, wait for it, and hand its results to the workflow.
// No dependencies: inputs come from INPUT_* variables, outputs go to $GITHUB_OUTPUT.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TERMINAL = ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'];
const WAIT_PER_REQUEST_SECS = 60;
const ITEMS_OUTPUT_MAX_BYTES = 1024 * 1024;
const FORMATS = ['json', 'jsonl', 'csv'];

class ActionError extends Error {}

function getInput(name, env = process.env) {
    const value = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
    return typeof value === 'string' ? value.trim() : '';
}

function bool(value, name) {
    if (/^(true|yes|1)$/i.test(value)) return true;
    if (/^(false|no|0)$/i.test(value)) return false;
    throw new ActionError(`${name} must be true or false`);
}

function positiveInt(value, name, { allowEmpty = false } = {}) {
    if (value === '' && allowEmpty) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new ActionError(`${name} must be a whole number greater than 0`);
    return n;
}

/** All inputs, checked. */
function readInputs(env = process.env) {
    const token = getInput('api-token', env);
    if (!token) throw new ActionError('api-token is required');
    const actor = getInput('actor', env);
    const task = getInput('task', env);
    if (!actor === !task) throw new ActionError('Set exactly one of actor or task');

    const inputFile = getInput('input-file', env);
    let rawInput = getInput('input', env) || '{}';
    if (inputFile) {
        try {
            rawInput = fs.readFileSync(inputFile, 'utf8');
        } catch (err) {
            throw new ActionError(`Could not read input-file ${inputFile}: ${err.message}`);
        }
    }
    let input;
    try {
        input = JSON.parse(rawInput);
    } catch {
        throw new ActionError(`The ${inputFile ? 'input-file' : 'input'} is not valid JSON`);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ActionError('The run input must be a JSON object');

    const format = getInput('output-format', env) || 'json';
    if (!FORMATS.includes(format)) throw new ActionError(`output-format must be one of: ${FORMATS.join(', ')}`);

    return {
        token,
        actor,
        task,
        input,
        wait: bool(getInput('wait', env) || 'true', 'wait'),
        maxWait: positiveInt(getInput('max-wait', env) || '3600', 'max-wait'),
        build: getInput('build', env),
        memory: positiveInt(getInput('memory', env), 'memory', { allowEmpty: true }),
        timeout: positiveInt(getInput('timeout', env), 'timeout', { allowEmpty: true }),
        outputFile: getInput('output-file', env),
        format,
        maxItems: positiveInt(getInput('max-items', env) || '1000', 'max-items'),
        failOnError: bool(getInput('fail-on-error', env) || 'true', 'fail-on-error'),
        baseUrl: (getInput('base-url', env) || 'https://api.scrape.ly').replace(/\/+$/, ''),
    };
}

/** username/name is sent as username~name in a path. */
function actorPath(actor) {
    return encodeURIComponent(actor.replace('/', '~'));
}

function setOutput(name, value, env = process.env) {
    const file = env.GITHUB_OUTPUT;
    const text = String(value ?? '');
    if (!file) return;
    const delimiter = `ghadelimiter_${crypto.randomUUID()}`;
    fs.appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

function summary(markdown, env = process.env) {
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

async function api(opts, method, pathAndQuery, { body, raw = false } = {}) {
    const res = await opts.fetch(`${opts.baseUrl}${pathAndQuery}`, {
        method,
        headers: {
            Authorization: `Bearer ${opts.token}`,
            'User-Agent': 'scrapely-action',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
        let message = text.slice(0, 300);
        try {
            message = JSON.parse(text)?.error?.message ?? message;
        } catch { /* not JSON */ }
        throw new ActionError(`Scrape.ly API ${method} ${pathAndQuery.split('?')[0]} failed (HTTP ${res.status}): ${message}`);
    }
    if (raw) return text;
    const json = text ? JSON.parse(text) : null;
    return json && typeof json === 'object' && 'data' in json ? json.data : json;
}

async function run({ env = process.env, fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log } = {}) {
    const inputs = readInputs(env);
    log(`::add-mask::${inputs.token}`);
    const opts = { ...inputs, fetch: fetchImpl };

    const qs = new URLSearchParams();
    if (inputs.build) qs.set('build', inputs.build);
    if (inputs.memory) qs.set('memory', String(inputs.memory));
    if (inputs.timeout) qs.set('timeout', String(inputs.timeout));
    const startPath = inputs.actor ? `/v2/actors/${actorPath(inputs.actor)}/runs` : `/v2/actor-tasks/${encodeURIComponent(inputs.task)}/runs`;
    const label = inputs.actor ? `Actor ${inputs.actor}` : `Task ${inputs.task}`;

    let runInfo = await api(opts, 'POST', `${startPath}${qs.size ? `?${qs}` : ''}`, { body: inputs.input });
    log(`Started run ${runInfo.id} of ${label}`);

    if (inputs.wait) {
        const started = Date.now();
        while (!TERMINAL.includes(runInfo.status)) {
            const elapsed = (Date.now() - started) / 1000;
            if (elapsed >= inputs.maxWait) throw new ActionError(`Run ${runInfo.id} is still ${runInfo.status} after ${inputs.maxWait} seconds`);
            const wait = Math.max(1, Math.min(WAIT_PER_REQUEST_SECS, Math.ceil(inputs.maxWait - elapsed)));
            const before = Date.now();
            runInfo = await api(opts, 'GET', `/v2/actor-runs/${encodeURIComponent(runInfo.id)}?waitForFinish=${wait}`);
            if (!TERMINAL.includes(runInfo.status) && Date.now() - before < 1000) await sleep(1000);
        }
        log(`Run ${runInfo.id} finished: ${runInfo.status}`);
    }

    setOutput('run-id', runInfo.id, env);
    setOutput('status', runInfo.status, env);
    setOutput('dataset-id', runInfo.defaultDatasetId ?? '', env);
    setOutput('key-value-store-id', runInfo.defaultKeyValueStoreId ?? '', env);

    let items = [];
    if (inputs.wait && runInfo.status === 'SUCCEEDED' && runInfo.defaultDatasetId) {
        const itemsPath = `/v2/datasets/${encodeURIComponent(runInfo.defaultDatasetId)}/items`;
        const json = await api(opts, 'GET', `${itemsPath}?format=json&clean=1&limit=${inputs.maxItems}`, { raw: true });
        items = JSON.parse(json || '[]');
        if (!Array.isArray(items)) items = items?.items ?? [];
        if (inputs.outputFile) {
            const content = inputs.format === 'json'
                ? json
                : await api(opts, 'GET', `${itemsPath}?format=${inputs.format}&clean=1&limit=${inputs.maxItems}&bom=0`, { raw: true });
            fs.mkdirSync(path.dirname(path.resolve(inputs.outputFile)), { recursive: true });
            fs.writeFileSync(inputs.outputFile, content);
            log(`Saved ${items.length} result(s) to ${inputs.outputFile}`);
        }
    }
    setOutput('items-count', items.length, env);
    const itemsJson = JSON.stringify(items);
    if (Buffer.byteLength(itemsJson) <= ITEMS_OUTPUT_MAX_BYTES) setOutput('items', itemsJson, env);
    else log('::warning::The results are larger than 1 MB, so the items output is empty. Use output-file instead.');

    const duration = runInfo.startedAt && runInfo.finishedAt
        ? `${Math.round((new Date(runInfo.finishedAt) - new Date(runInfo.startedAt)) / 1000)}s`
        : '–';
    summary([
        `### Scrape.ly run ${runInfo.status === 'SUCCEEDED' ? '✅' : TERMINAL.includes(runInfo.status) ? '❌' : '⏳'}`,
        '',
        '| | |',
        '|---|---|',
        `| ${inputs.actor ? 'Actor' : 'Task'} | \`${inputs.actor || inputs.task}\` |`,
        `| Run | \`${runInfo.id}\` |`,
        `| Status | ${runInfo.status} |`,
        `| Duration | ${duration} |`,
        `| Results | ${items.length} |`,
        ...(items.length ? ['', '<details><summary>First results</summary>', '', '```json', JSON.stringify(items.slice(0, 3), null, 2), '```', '</details>'] : []),
    ].join('\n'), env);

    if (inputs.wait && runInfo.status !== 'SUCCEEDED') {
        const message = `Run ${runInfo.id} ended with status ${runInfo.status}${runInfo.statusMessage ? `: ${runInfo.statusMessage}` : ''}`;
        if (inputs.failOnError) throw new ActionError(message);
        log(`::warning::${message}`);
    }
    return { run: runInfo, items };
}

module.exports = { run, readInputs, ActionError };

if (require.main === module) {
    run().catch((err) => {
        console.log(`::error::${err instanceof ActionError ? err.message : err.stack || err.message}`);
        process.exitCode = 1;
    });
}
