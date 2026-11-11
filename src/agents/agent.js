// Agent + Team: a small JavaScript take on agno's Agent and Team classes,
// running on the Gemini API with function calling and Google Search grounding.

import { generate, generateStream, groundingSources, textOf } from '../lib/gemini.js';

const MAX_TOOL_STEPS = 8;
const MAX_TEAM_STEPS = 4;

const today = () =>
  new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

const asList = (x) => (Array.isArray(x) ? x : x ? [x] : []);

let callSeq = 0;

export class Agent {
  /**
   * @param {object} o
   * @param {string} o.id           Stable id, used by the team leader to delegate.
   * @param {string} o.name
   * @param {string} o.role         One-line role shown to the team leader.
   * @param {string[]|string} o.instructions
   * @param {Array} [o.tools]       Function tools ({ name, declaration, run }).
   * @param {boolean} [o.googleSearch] Give the agent live internet access via Google Search grounding.
   */
  constructor({ id, name, role, instructions, tools = [], googleSearch = false }) {
    Object.assign(this, { id, name, role, instructions: asList(instructions), tools, googleSearch });
    this.toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
  }

  systemPrompt() {
    return [
      `You are "${this.name}". Your role: ${this.role}`,
      ...this.instructions,
      `Today's date is ${today()}. Treat tool and search results as the source of truth for anything time-sensitive.`,
      'Respond in Markdown. Be concise and factual; include concrete numbers and dates you found.',
    ].join('\n\n');
  }

  apiTools() {
    // Google Search grounding and custom functions are kept on separate agents,
    // which works on every Gemini model.
    if (this.googleSearch) return [{ googleSearch: {} }];
    return this.tools.length ? [{ functionDeclarations: this.tools.map((t) => t.declaration) }] : undefined;
  }

  /** Runs the agent's tool loop and resolves to { text, sources }. */
  async run(task, ctx) {
    const { apiKey, model, signal, emit = () => {}, addSources = () => {} } = ctx;
    const contents = [{ role: 'user', parts: [{ text: task }] }];
    const sources = [];
    const collect = (list) => {
      sources.push(...list);
      addSources(list);
    };

    for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
      const lastStep = step === MAX_TOOL_STEPS;
      const r = await generate({
        apiKey,
        model,
        signal,
        system: this.systemPrompt(),
        contents,
        tools: this.apiTools(),
        // Out of steps: make the model answer with what it has.
        toolConfig: lastStep && !this.googleSearch ? { functionCallingConfig: { mode: 'NONE' } } : undefined,
      });

      if (r.blockReason) throw new Error(`Request blocked by Gemini (${r.blockReason}).`);
      collect(groundingSources(r.groundingMetadata));
      for (const q of r.groundingMetadata?.webSearchQueries ?? []) {
        emit({ type: 'search', member: this.id, query: q });
      }

      const calls = r.parts.filter((p) => p.functionCall);
      if (!calls.length) {
        const text = textOf(r.parts).trim();
        return { text: text || '_No answer was produced._', sources };
      }

      // Keep the model turn verbatim — Gemini 3+ needs its thoughtSignature back.
      contents.push({ role: 'model', parts: r.parts });
      const responses = await Promise.all(calls.map((p) => this.#callTool(p.functionCall, ctx, collect)));
      contents.push({ role: 'user', parts: responses });
    }
    return { text: '_The agent ran out of steps._', sources };
  }

  async #callTool(call, ctx, collect) {
    const { signal, emit = () => {} } = ctx;
    const callId = `c${++callSeq}`;
    const args = call.args ?? {};
    const tool = this.toolMap[call.name];
    emit({ type: 'tool:start', member: this.id, tool: call.name, args, callId });

    let response;
    try {
      if (!tool) throw new Error(`Unknown tool "${call.name}".`);
      const result = await tool.run(args, { signal, emit, addSources: collect });
      response = { result };
      emit({ type: 'tool:end', member: this.id, tool: call.name, callId, ok: !result?.error, error: result?.error });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      response = { error: err?.message || String(err) };
      emit({ type: 'tool:end', member: this.id, tool: call.name, callId, ok: false, error: response.error });
    }
    return { functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response } };
  }
}

export class Team {
  /**
   * The leader decides which members to involve, delegates (in parallel) via
   * a `delegate_task_to_member` tool, then writes the final answer — streamed.
   */
  constructor({ name, members, instructions }) {
    Object.assign(this, { name, members, instructions: asList(instructions) });
    this.memberMap = Object.fromEntries(members.map((m) => [m.id, m]));
    this.history = []; // compact multi-turn memory: user prompts + final answers
  }

  reset() {
    this.history = [];
  }

  systemPrompt(extra = []) {
    const roster = this.members.map((m) => `- \`${m.id}\` — **${m.name}**: ${m.role}`).join('\n');
    return [
      `You are the leader of "${this.name}", a team of AI agents that helps everyday people with personal finance and investing questions.`,
      `Your team members:\n${roster}`,
      [
        'How to work:',
        '- Delegate with the `delegate_task_to_member` tool. Give each member a specific, self-contained task (include tickers, company names and time frames).',
        '- Delegate to several members at once by issuing multiple tool calls in the same turn, so they work in parallel.',
        '- For a stock/company/fund question, normally use all members: the Financial Analyst for numbers, the Company News Researcher for Yahoo Finance headlines, and the Web Researcher for the latest internet coverage.',
        '- For market-wide or current-events questions, use the Web Researcher (and the News Researcher for trending tickers).',
        '- For general personal-finance concepts (budgeting, emergency funds, how index funds work…) you may answer directly without delegating.',
        '- Follow-up questions can build on the conversation so far; only delegate again when you need new data.',
        '- If a member reports missing data or an error, work with what you have and do not mention internal tool errors in detail.',
      ].join('\n'),
      ...this.instructions,
      ...extra,
      [
        'Ground rules:',
        '- Never invent facts or numbers. Only use data returned by your team or well-established general knowledge.',
        '- Mention the date of prices you quote ("as of …"). Never claim unavailable data is current.',
        '- Never guarantee returns. This is educational information, not personalised financial advice; say so briefly at the end of investment answers.',
        '- Answer in Markdown with short headings and concise bullets.',
      ].join('\n'),
      `Today's date is ${today()}.`,
    ].join('\n\n');
  }

  delegateTool() {
    return {
      name: 'delegate_task_to_member',
      description: 'Assign a task to one team member and receive their findings. Call it several times in one turn to run members in parallel.',
      parameters: {
        type: 'object',
        properties: {
          member_id: { type: 'string', enum: this.members.map((m) => m.id), description: 'Which member to delegate to.' },
          task: { type: 'string', description: 'A clear, self-contained task, including tickers and what to return.' },
        },
        required: ['member_id', 'task'],
      },
    };
  }

  /**
   * @param {string} prompt
   * @param {object} ctx { apiKey, model, signal, emit, onText, onTextReset, extraInstructions }
   * @returns {Promise<{ text: string, sources: {title,url}[] }>}
   */
  async run(prompt, ctx) {
    const { apiKey, model, signal, emit = () => {}, onText, onTextReset, extraInstructions = [] } = ctx;
    const sources = [];
    const addSources = (list) => sources.push(...list);
    const userTurn = { role: 'user', parts: [{ text: prompt }] };
    const contents = [...this.history, userTurn];
    const tools = [{ functionDeclarations: [this.delegateTool()] }];

    emit({ type: 'leader:start' });
    for (let step = 0; step <= MAX_TEAM_STEPS; step++) {
      const lastStep = step === MAX_TEAM_STEPS;
      let streamed = '';
      const r = await generateStream({
        apiKey,
        model,
        signal,
        system: this.systemPrompt(extraInstructions),
        contents,
        tools,
        toolConfig: lastStep ? { functionCallingConfig: { mode: 'NONE' } } : undefined,
        onText: (t) => {
          streamed += t;
          onText?.(t);
        },
      });
      if (r.blockReason) throw new Error(`Request blocked by Gemini (${r.blockReason}).`);

      const calls = r.parts.filter((p) => p.functionCall);
      if (!calls.length) {
        const text = textOf(r.parts).trim();
        this.history.push(userTurn, { role: 'model', parts: r.parts.filter((p) => !p.thought) });
        emit({ type: 'leader:end' });
        return { text, sources: dedupe(sources) };
      }

      // Text written before delegating is "planning" — move it to the activity log.
      if (streamed.trim()) emit({ type: 'leader:note', text: streamed.trim() });
      onTextReset?.();

      contents.push({ role: 'model', parts: r.parts });
      const responses = await Promise.all(
        calls.map(async ({ functionCall: call }) => {
          const { member_id, task } = call.args ?? {};
          const member = this.memberMap[member_id];
          let response;
          if (!member) {
            response = { error: `Unknown member "${member_id}".` };
          } else {
            emit({ type: 'member:start', member: member.id, task });
            try {
              const out = await member.run(String(task || prompt), { apiKey, model, signal, emit, addSources });
              response = { member: member.name, findings: out.text };
              emit({ type: 'member:end', member: member.id, ok: true, text: out.text });
            } catch (err) {
              if (err?.name === 'AbortError') throw err;
              response = { member: member.name, error: err?.message || String(err) };
              emit({ type: 'member:end', member: member.id, ok: false, error: response.error });
            }
          }
          return { functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response } };
        }),
      );
      contents.push({ role: 'user', parts: responses });
    }
    throw new Error('The team could not finish the answer.');
  }
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((s) => s?.url && !seen.has(s.url) && seen.add(s.url));
}
