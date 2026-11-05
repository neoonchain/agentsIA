// The app: ties vault, models (team or solo), paper broker, Brake and evaluator together.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, MODELS } from './config.js';
import * as V from './vault.js';
import * as T from './trading.js';
import { getPrice, getCandles, candleSummary, validAsset } from './market.js';
import { openInstruction, closeInstruction, chat, parseJSON } from './llm.js';
import * as K from './kraken.js';
import * as L from './live.js';
const px = L.fmtPx;

const BASE = `You are part of agentsIA, a trading-journal assistant working from the user's own Obsidian vault.
Be concrete and brief. Refer to notes as [[Note name]]. Never invent trades or numbers that are not in the data you are given.
This is paper trading and journaling, not financial advice.`;

export class App {
  constructor() {
    this.config = loadConfig();
    this.locks = new Set();
    this.activity = [];
    this.openVault();
  }

  /* ---------- vault & state ---------- */
  openVault() {
    this.vault = this.config.vaultPath;
    V.initVault(this.vault);
    this.stateFile = path.join(this.vault, '.agentsia', 'state.json');
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { this.state = {}; }
    this.state.accounts ||= {}; this.state.promotions ||= {}; this.state.live ||= {};
  }
  save() {
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.stateFile);
  }
  setConfig(c) {
    const prev = this.config;
    this.config = c;
    if (c.vaultPath !== prev.vaultPath) {
      try { this.openVault(); }
      catch (e) { this.config = prev; this.openVault(); throw Object.assign(new Error(`Cannot use that vault folder: ${e.message}`), { status: 400 }); }
    }
    saveConfig(c);
  }
  note(msg) {
    this.activity.unshift({ at: new Date().toISOString(), msg });
    this.activity.length = Math.min(this.activity.length, 100);
    V.appendLog(this.vault, msg);
  }
  rules() { return V.readNote(this.vault, 'rules.md').data; }

  strategies() {
    return V.listNotes(this.vault, 'Strategies').map(p => {
      const n = V.readNote(this.vault, p);
      const name = String(n.data.name || path.basename(p, '.md'));
      return { path: p, name, ...n.data, assets: [].concat(n.data.assets || []).map(String), body: n.body };
    });
  }
  strategy(name) {
    const s = this.strategies().find(x => x.name === name);
    if (!s) throw Object.assign(new Error(`No strategy "${name}"`), { status: 404 });
    return s;
  }
  setStrategyStatus(name, status) {
    const s = this.strategy(name);
    const n = V.readNote(this.vault, s.path);
    V.writeNote(this.vault, s.path, { ...n.data, status }, n.body);
  }
  liveOf(name) { const l = this.state.live[name]; return l?.enabled ? l : null; }
  creds() { return this.config.kraken || null; }
  account(name) {
    return (this.state.accounts[name] ||= T.newAccount(this.rules()));
  }

  /* ---------- models ---------- */
  model(role) {
    const key = this.config.mode === 'solo' ? this.config.soloModel : this.config.roles[role];
    return { key, id: this.config.models[key] || MODELS[key].id, label: MODELS[key].label };
  }
  roleOn(role) { return this.config.mode === 'team' && this.config.enabledRoles[role]; }
  async call(ins, role, task, system, user, opts = {}) {
    const m = this.model(role);
    const text = await chat(ins, { modelId: m.id, system: `${BASE}\n\n${system}`, user, task, role, ...opts });
    return { role, model: m.label, text };
  }
  async instruction(kind, fn) {
    const ins = await openInstruction(this.config, kind);
    try { return await fn(ins); }
    finally { await closeInstruction(this.config, ins); }
  }

  journalContext(limit = 30) {
    const trades = V.listJournal(this.vault);
    const m = T.metrics(trades, Number(this.rules().starting_balance) || 10000);
    const lines = trades.slice(-limit).map(t =>
      `- [[${path.basename(t.path, '.md')}]] ${t.date} ${t.asset} ${t.side} entry ${t.entry} stop ${t.stop} exit ${t.exit} pnl ${t.pnl} R ${t.r ?? '?'} strategy "${t.strategy}" emotion "${t.emotion}" tags ${t.tags.join(',')}\n  thesis: ${t.thesis.slice(0, 200)}\n  psychology: ${t.psychology.slice(0, 160)}\n  went well: ${t.wentWell.slice(0, 160)}\n  went wrong: ${t.wentWrong.slice(0, 160)}`);
    const extra = [...V.listNotes(this.vault, 'Strategies'), ...V.listNotes(this.vault, 'Psychology')]
      .map(p => `### [[${path.basename(p, '.md')}]]\n${V.readNote(this.vault, p).body.slice(0, 800)}`).join('\n\n');
    return `Journal stats: ${trades.length} trades, win rate ${m.winRate}%, profit factor ${m.profitFactor}, total PnL ${m.totalPnl}, avg R ${m.avgR}, max drawdown ${m.maxDrawdownPct}%.\n\nRecent trades:\n${lines.join('\n') || '(no trades logged yet)'}\n\nStrategy and psychology notes:\n${extra || '(none)'}`;
  }

  /* ---------- ask ---------- */
  ask(question) {
    const q = String(question || '').trim().slice(0, 2000);
    if (!q) throw Object.assign(new Error('Write a question first'), { status: 400 });
    return this.instruction('ask', async ins => {
      const ctx = this.journalContext();
      const steps = [];
      const draft = await this.call(ins, 'lead', 'ask', 'You are the lead analyst. Answer the user using their journal.', `${ctx}\n\nQuestion: ${q}`);
      steps.push(draft);
      let answer = draft.text;
      if (this.roleOn('reviewer')) {
        const rv = await this.call(ins, 'reviewer', 'review', 'You are the second opinion. Check the draft answer against the journal data for errors, unsupported claims or missing risks. Reply ONLY with JSON: {"agree": true|false, "issues": ["..."]}',
          `${ctx}\n\nQuestion: ${q}\n\nDraft answer:\n${draft.text}`, { maxTokens: 600 });
        steps.push(rv);
        let verdict; try { verdict = parseJSON(rv.text); } catch { verdict = { agree: true, issues: [] }; }
        if (verdict.agree === false && verdict.issues?.length) {
          const rev = await this.call(ins, 'lead', 'revise', 'You are the lead analyst. Revise your answer to address the reviewer\'s issues. Output only the final answer.',
            `${ctx}\n\nQuestion: ${q}\n\nYour draft:\n${draft.text}\n\nReviewer issues:\n- ${verdict.issues.join('\n- ')}`);
          steps.push(rev); answer = rev.text;
        }
      }
      this.note(`ask (${this.config.mode}) · ${q.slice(0, 80)}`);
      return { answer, mode: this.config.mode, steps };
    });
  }

  /* ---------- analyse the journal ---------- */
  analyse() {
    return this.instruction('analyse', async ins => {
      const ctx = this.journalContext(60);
      const rules = this.rules();
      const stratSpec = `"strategy": {"name": "short name", "assets": ["BTC-USD"], "risk_per_trade_pct": 1, "hours_utc": "07:00-17:00", "rules": ["..."]}`;
      const steps = [];
      let lead, psych = { patterns: [], rules: [] }, review = null;
      if (this.config.mode === 'solo') {
        const r = await this.call(ins, 'lead', 'analyse', `Analyse the journal: performance, psychology and one strategy to paper trade. Reply ONLY with JSON: {"summary": "...", "strengths": ["..."], "weaknesses": ["..."], "psychology": {"patterns": ["..."], "rules": ["..."]}, ${stratSpec}}. Assets use Coinbase symbols like BTC-USD.`, ctx, { maxTokens: 2000 });
        steps.push(r); lead = parseJSON(r.text); psych = lead.psychology || psych;
      } else {
        const r = await this.call(ins, 'lead', 'analyse', `You are the lead analyst. Find what wins and what loses in this journal and propose one strategy to paper trade. Reply ONLY with JSON: {"summary": "...", "strengths": ["..."], "weaknesses": ["..."], ${stratSpec}}. Assets use Coinbase symbols like BTC-USD.`, ctx, { maxTokens: 2000 });
        steps.push(r); lead = parseJSON(r.text);
        if (this.roleOn('psychology')) {
          const p = await this.call(ins, 'psychology', 'psychology', 'You are the psychology coach. From the emotion, psychology and went-wrong notes, find behaviour patterns and turn them into concrete rules. Reply ONLY with JSON: {"patterns": ["..."], "rules": ["..."]}', ctx, { maxTokens: 1000 });
          steps.push(p); try { psych = parseJSON(p.text); } catch { psych = { patterns: [p.text.slice(0, 500)], rules: [] }; }
        }
        if (this.roleOn('reviewer')) {
          const v = await this.call(ins, 'reviewer', 'review', 'You are the second opinion. Check this analysis and strategy against the journal. Reply ONLY with JSON: {"agree": true|false, "issues": ["..."]}', `${ctx}\n\nAnalysis:\n${JSON.stringify({ lead, psych })}`, { maxTokens: 700 });
          steps.push(v); try { review = parseJSON(v.text); } catch { review = null; }
        }
      }
      const day = new Date().toISOString().slice(0, 10);
      const list = a => (Array.isArray(a) && a.length ? a.map(x => `- ${x}`).join('\n') : '- (none)');
      const insight = V.uniquePath(this.vault, `Insights/${day} ${this.config.mode === 'team' ? 'Team' : 'Solo'} analysis.md`);
      V.writeNote(this.vault, insight, { date: day, mode: this.config.mode, models: [...new Set(steps.map(s => s.model))], tags: ['insight'] },
        `# Journal analysis\n\n${lead.summary || ''}\n\n## Strengths\n${list(lead.strengths)}\n\n## Weaknesses\n${list(lead.weaknesses)}\n\n## Psychology patterns\n${list(psych.patterns)}\n\n## Suggested rules\n${list(psych.rules)}\n` +
        (review ? `\n## Second opinion (${steps.find(s => s.role === 'reviewer')?.model})\n${review.agree ? 'Agrees.' : 'Disagrees.'}\n${list(review.issues)}\n` : ''));
      let strategyPath = null;
      const s = lead.strategy;
      if (s && s.name) {
        const assets = [].concat(s.assets || []).map(a => String(a).toUpperCase()).filter(validAsset);
        const maxRisk = Number(rules.max_risk_per_trade_pct) || 2;
        strategyPath = V.uniquePath(this.vault, `Strategies/${V.safeName(s.name)} (draft).md`);
        V.writeNote(this.vault, strategyPath, {
          name: `${V.safeName(s.name)} (draft)`, status: 'stopped', draft: true, assets: assets.length ? assets : ['BTC-USD'], timeframe: '1h',
          risk_per_trade_pct: Math.min(Math.max(Number(s.risk_per_trade_pct) || 1, 0.1), maxRisk),
          hours_utc: /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(s.hours_utc || '') ? s.hours_utc : '00:00-23:59', interval_min: 60,
        }, `# ${s.name}\n\nDrafted by the ${this.config.mode === 'team' ? 'team' : 'model'} from [[${path.basename(insight, '.md')}]]. Review it, then remove "(draft)" and start it.\n\n## Rules\n${list(s.rules)}\n`);
      }
      this.note(`analysis (${this.config.mode}) · wrote [[${path.basename(insight, '.md')}]]`);
      return { insight, strategy: strategyPath, review, steps, mode: this.config.mode };
    });
  }

  /* ---------- one trading decision for a strategy ---------- */
  async decide(name, { manual = false } = {}) {
    if (this.locks.has(name)) throw Object.assign(new Error('A decision is already running for this strategy'), { status: 409 });
    this.locks.add(name);
    try {
      const s = this.strategy(name);
      const rules = this.rules();
      const live = this.liveOf(name);
      const acc = live ? live.account : this.account(name);
      if (!s.assets.length) throw new Error('Strategy has no assets');
      const prices = {}, charts = {};
      for (const a of s.assets) { prices[a] = live ? (await K.ticker(a)).mid : await getPrice(a); charts[a] = candleSummary(await getCandles(a, 48)); }
      if (live) { const rs = L.liveRiskState(live, prices, rules); if (rs) await this.handleLiveRisk(s, live, rs); }
      else for (const ev of T.riskTick(acc, prices, rules)) this.handleRiskEvent(s, ev);
      if (acc.paused || this.strategy(name).status === 'stopped' && !manual) { this.save(); return { action: 'skip', reason: acc.paused?.reason || 'stopped' }; }

      return await this.instruction('trade', async ins => {
        const steps = [];
        const market = s.assets.map(a => `## ${a} price ${prices[a]}\n${charts[a]}`).join('\n\n');
        const positions = Object.values(acc.positions).map(p => `${p.asset} ${p.side} qty ${px(p.qty)} entry ${px(p.entry)} stop ${p.stop} tp ${p.takeProfit}`).join('\n') || 'none';
        const where = live ? 'REAL-MONEY (Kraken spot: long only, no shorting, no leverage)' : 'paper';
        const ctxParts = [`Strategy note [[${s.name}]]:\n${s.body}`, `Strategy settings: assets ${s.assets.join(', ')}, hours ${s.hours_utc || 'any'} UTC, max risk ${Math.min(Number(s.risk_per_trade_pct) || 1, Number(rules.max_risk_per_trade_pct) || 2)}% per trade.`,
          `Open ${where} positions: ${positions}`, `${live ? 'Real allocation' : 'Paper'} equity ${T.equity(acc, prices).toFixed(2)} (start ${acc.startBalance}). Current UTC time ${new Date().toISOString()}.`];
        if (live) ctxParts.push('This strategy trades REAL money on Kraken: only "long" opens are possible. Prefer "hold" when the setup is not clean.');
        if (this.roleOn('charts')) {
          const c = await this.call(ins, 'charts', 'chart', 'You read charts. From these candles give trend, support, resistance and whether a setup matching the strategy is forming. Reply ONLY with JSON: {"assets": {"BTC-USD": {"trend": "up|down|range", "support": 0, "resistance": 0, "setup": "..."}}}', market, { maxTokens: 700 });
          steps.push(c); ctxParts.push(`Chart reading (${c.model}):\n${c.text}`);
        }
        for (const role of ['context', 'sentiment']) {
          if (this.roleOn(role) && this.config.webSearch) {
            const r = await this.call(ins, role, role, role === 'context' ? 'Summarise macro and news that matter for these assets in the next hours, in 3 bullets.' : 'Summarise current social and news sentiment for these assets in 3 bullets, and flag unusual spikes.', `Assets: ${s.assets.join(', ')}`, { maxTokens: 400, web: true });
            steps.push(r); ctxParts.push(`${role === 'context' ? 'Market context' : 'Sentiment'} (${r.model}):\n${r.text}`);
          }
        }
        const lead = await this.call(ins, 'lead', 'propose', `You are the trader for this strategy, which was built from the user's journal. Follow its rules strictly. Decide ONE action. Reply ONLY with JSON:
{"action": "open"|"close"|"hold", "asset": "BTC-USD", "side": "long"|"short", "stop": 0, "take_profit": 0, "risk_pct": 1, "thesis": "...", "links": ["journal note names that support this"]}
For "hold" only "action" and "thesis" are needed. For "close" give the asset.`, `${ctxParts.join('\n\n')}\n\n${market}\n\nUser journal context:\n${this.journalContext(15)}`, { maxTokens: 900 });
        steps.push(lead);
        let p;
        try { p = parseJSON(lead.text); } catch (e) { p = { action: 'hold', thesis: `Unreadable proposal: ${e.message}` }; }
        p.asset = p.asset ? String(p.asset).toUpperCase() : s.assets[0];
        let reviewerAgreed, reviewReason = '';
        if (p.action !== 'hold' && this.roleOn('reviewer')) {
          const rv = await this.call(ins, 'reviewer', 'review', 'You are the second opinion on a paper trade. Check it against the strategy rules, the chart and the journal lessons. Reply ONLY with JSON: {"agree": true|false, "reason": "..."}', `${ctxParts.join('\n\n')}\n\nProposal from ${lead.model}:\n${JSON.stringify(p)}`, { maxTokens: 400 });
          steps.push(rv);
          try { const v = parseJSON(rv.text); reviewerAgreed = v.agree === true; reviewReason = String(v.reason || ''); } catch { reviewerAgreed = false; reviewReason = 'Unreadable review'; }
        }
        const price = prices[p.asset];
        let verdict = (p.action === 'open' && typeof price !== 'number')
          ? { ok: false, reasons: [`${p.asset} is not in the strategy`], offStrategy: true }
          : T.brake(p, { strategy: s, rules, acc, price, mode: this.config.mode, reviewerAgreed });
        if (live && p.action === 'open' && verdict.ok) {
          const extra = L.liveChecks(p, await K.ticker(p.asset), rules);
          if (extra.length) verdict = { ok: false, reasons: extra, offStrategy: p.side !== 'long' };
        }
        if (p.action !== 'hold') { acc.proposals.total++; if (verdict.offStrategy) acc.proposals.offStrategy++; }
        acc.lastDecisionAt = new Date().toISOString();
        let result = { action: p.action, proposal: p, verdict, reviewerAgreed, reviewReason, steps, mode: this.config.mode, live: live ? live.mode : null };
        if (p.action === 'hold') this.note(`[[${s.name}]] hold · ${String(p.thesis || '').slice(0, 100)}`);
        else if (!verdict.ok) this.note(`[[${s.name}]] ${p.action} ${p.asset} blocked · ${verdict.reasons.join('; ')}${reviewReason ? ' · reviewer: ' + reviewReason.slice(0, 80) : ''}`);
        else if (p.action === 'close') {
          const t = live ? await L.closeLive({ creds: this.creds(), live, asset: p.asset, reason: 'model close', rules }) : T.closePosition(acc, p.asset, price, 'model close', rules);
          this.recordClose(s, t); result.trade = t;
        }
        else {
          const notePath = V.uniquePath(this.vault, `Agents/${V.safeName(s.name)}/${new Date().toISOString().slice(0, 10)} ${p.asset} ${p.side}.md`);
          const meta = { notePath, thesis: String(p.thesis || ''), proposer: lead.model, reviewer: steps.find(x => x.role === 'reviewer')?.model || null };
          let pos;
          try {
            pos = live ? await L.openLive({ creds: this.creds(), live, asset: p.asset, p, rules, meta })
              : T.openPosition(acc, { asset: p.asset, side: p.side, price, stop: Number(p.stop), takeProfit: p.take_profit ? Number(p.take_profit) : null, riskPct: Number(p.risk_pct), rules, meta });
          } catch (e) {
            result.verdict = { ok: false, reasons: [e.message], offStrategy: false };
            this.note(`[[${s.name}]] open ${p.asset} failed · ${e.message}`); this.save();
            return result;
          }
          if (this.roleOn('scribe')) {
            try {
              const sc = await this.call(ins, 'scribe', 'scribe', 'You are the scribe. Rewrite this trade thesis as a clean journal entry in 2-4 short sentences: setup, why now, invalidation. Plain text, no headings.', `Proposal: ${JSON.stringify(p)}\n\n${ctxParts.slice(-1)[0] || ''}`, { maxTokens: 300 });
              steps.push(sc); pos.thesis = sc.text.trim();
            } catch { /* keep the lead's own thesis */ }
          }
          this.writeTradeNote(s, pos, p, reviewReason, steps);
          this.note(`[[${s.name}]] opened ${live ? (live.mode === 'real' ? 'REAL Kraken' : 'Kraken-validated') : 'paper'} ${p.side} ${p.asset} @ ${px(pos.entry)} stop ${pos.stop} · ${lead.model}${pos.reviewer ? ' + ' + pos.reviewer : ''}`);
          result.position = pos;
        }
        this.save();
        return result;
      });
    } finally { this.locks.delete(name); }
  }

  writeTradeNote(s, pos, p, reviewReason, steps, exit = null) {
    const links = [].concat(p?.links || []).map(l => `- [[${String(l).replace(/[\[\]]/g, '')}]]`).join('\n');
    V.writeNote(this.vault, pos.notePath, {
      date: pos.openedAt.slice(0, 16).replace('T', ' '), asset: pos.asset, side: pos.side, entry: px(pos.entry), stop: pos.stop,
      take_profit: pos.takeProfit, size: px(pos.qty), exit: exit ? px(exit.exit) : null, pnl: exit ? exit.pnl : null, r: exit ? exit.r : null,
      status: exit ? 'closed' : 'open', strategy: s.name, account: pos.mode ? `kraken-${pos.mode}` : 'paper', kraken_entry: pos.entryTxid || undefined, kraken_stop: pos.stopTxid || undefined, proposer: pos.proposer, reviewer: pos.reviewer, tags: ['agent', 'paper'],
    }, `## Thesis\n${pos.thesis}\n\n## Second opinion\n${pos.reviewer ? `${pos.reviewer}: ${reviewReason || 'agreed'}` : 'Solo mode: no second opinion.'}\n\n## Sources\n${links || '- (none given)'}\n` +
      (steps ? `\n## Models involved\n${steps.map(x => `- ${x.role}: ${x.model}`).join('\n')}\n` : '') +
      (exit ? `\n## Result\nClosed by ${exit.reason} at ${px(exit.exit)}: ${exit.pnl >= 0 ? '+' : ''}${exit.pnl} USD (${exit.r}R).\n` : ''));
  }

  recordClose(s, t) {
    if (!t) return;
    if (t.notePath) {
      try {
        const n = V.readNote(this.vault, t.notePath);
        V.writeNote(this.vault, t.notePath, { ...n.data, exit: px(t.exit), pnl: t.pnl, r: t.r, status: 'closed' },
          n.body + `\n## Result\nClosed by ${t.reason} at ${px(t.exit)}: ${t.pnl >= 0 ? '+' : ''}${t.pnl} USD (${t.r}R).\n`);
      } catch { /* note was moved or deleted by the user */ }
    }
    this.note(`[[${s.name}]] closed ${t.asset} by ${t.reason} · ${t.pnl >= 0 ? '+' : ''}${t.pnl} USD (${t.r}R)`);
  }

  handleRiskEvent(s, ev) {
    if (ev.type === 'closed') this.recordClose(s, ev.trade);
    if (ev.type === 'paused') this.note(`[[${s.name}]] paused until tomorrow · ${ev.reason}`);
    if (ev.type === 'resumed') this.note(`[[${s.name}]] resumed`);
    if (ev.type === 'stop') { this.setStrategyStatus(s.name, 'stopped'); this.note(`[[${s.name}]] stopped by Brake · ${ev.reason}`); }
  }

  /* ---------- scheduler: exits every tick, decisions on each strategy's interval ---------- */
  async tick(now = new Date()) {
    const out = [];
    const watched = this.strategies().filter(x => x.status === 'running' || this.liveOf(x.name) || Object.keys(this.state.accounts[x.name]?.positions || {}).length);
    for (const s of watched) {
      try {
        const live = this.liveOf(s.name), rules = this.rules();
        const acc = live ? live.account : this.account(s.name);
        const prices = {};
        for (const a of new Set([...s.assets, ...Object.keys(acc.positions)])) prices[a] = live ? (await K.ticker(a)).bid : await getPrice(a);
        if (live) {
          for (const t of await L.syncLive({ creds: this.creds(), live, rules, prices })) this.recordClose(s, t);
          const rs = L.liveRiskState(live, prices, rules, now); if (rs) await this.handleLiveRisk(s, live, rs);
        } else {
          for (const t of T.checkExits(acc, prices, rules, now)) this.recordClose(s, t);
          for (const ev of T.riskTick(acc, prices, rules, now)) this.handleRiskEvent(s, ev);
        }
        this.save();
        const due = !acc.lastDecisionAt || now - Date.parse(acc.lastDecisionAt) >= (Number(s.interval_min) || 60) * 60000;
        if (s.status === 'running' && due && !acc.paused && !this.locks.has(s.name) && this.strategy(s.name).status === 'running') out.push({ name: s.name, ...(await this.decide(s.name)) });
      } catch (e) {
        if (e.code === 'NEED_KEY') { this.setStrategyStatus(s.name, 'stopped'); this.note(`[[${s.name}]] stopped · ${e.message}`); }
        else this.note(`[[${s.name}]] error · ${e.message}`);
        out.push({ name: s.name, error: e.message });
      }
    }
    return out;
  }

  start(name) {
    if (!this.config.apiKey) throw Object.assign(new Error('Paper trading runs on its own schedule, so it needs your own OpenRouter API key (Team settings).'), { status: 402, code: 'NEED_KEY' });
    const s = this.strategy(name);
    if (s.draft) throw Object.assign(new Error('This strategy is still a draft. Review it in Obsidian, set draft: false, then start it.'), { status: 400 });
    this.account(name); this.setStrategyStatus(name, 'running'); this.save();
    this.note(`[[${name}]] started on paper (${this.config.mode} mode)`);
  }
  stop(name) {
    this.strategy(name); this.setStrategyStatus(name, 'stopped');
    this.note(`[[${name}]] stopped by you`);
  }
  async handleLiveRisk(s, live, rs) {
    for (const a of Object.keys(live.account.positions)) this.recordClose(s, await L.closeLive({ creds: this.creds(), live, asset: a, reason: rs.action === 'stop' ? 'live max drawdown' : 'live daily loss limit', rules: this.rules() }));
    if (rs.action === 'stop') { live.enabled = false; live.stoppedReason = rs.reason; this.setStrategyStatus(s.name, 'stopped'); this.note(`[[${s.name}]] REAL MONEY STOPPED by Brake · ${rs.reason} · back to paper`); }
    else this.note(`[[${s.name}]] real money paused until tomorrow · ${rs.reason}`);
    this.save();
  }

  async setKraken({ key, secret }) {
    key = String(key || '').trim(); secret = String(secret || '').trim();
    if (!key || !secret) throw Object.assign(new Error('Paste both the API key and the private key'), { status: 400 });
    const creds = { key, secret };
    let check;
    try { check = await K.checkKey(creds); } catch (e) { throw Object.assign(new Error(`Kraken rejected the key: ${e.message}`), { status: 400 }); }
    if (!check.ok) throw Object.assign(new Error(check.reason), { status: 400 });
    this.config.kraken = { ...creds, checkedAt: new Date().toISOString() }; saveConfig(this.config);
    this.note('Kraken key connected (trade only, no withdrawals)');
  }
  removeKraken() {
    if (Object.values(this.state.live).some(l => l.enabled)) throw Object.assign(new Error('Send every live strategy back to paper first'), { status: 400 });
    delete this.config.kraken; saveConfig(this.config); this.note('Kraken key removed');
  }

  async enableLive(name, { mode, confirm }) {
    const s = this.strategy(name), promo = this.state.promotions[name];
    if (promo?.status !== 'approved') throw Object.assign(new Error('Approve the promotion first'), { status: 400 });
    if (!this.config.kraken) throw Object.assign(new Error('Connect a Kraken key in Team settings first'), { status: 400, code: 'NEED_EXCHANGE' });
    if (!this.config.apiKey) throw Object.assign(new Error('Live trading needs your own OpenRouter API key'), { status: 402, code: 'NEED_KEY' });
    if (mode !== 'validate' && mode !== 'real') throw Object.assign(new Error('Mode must be validate or real'), { status: 400 });
    if (this.liveOf(name)?.mode === mode) throw Object.assign(new Error(`Already live in ${mode} mode`), { status: 400 });
    if (this.liveOf(name) && Object.keys(this.liveOf(name).account.positions).length) throw Object.assign(new Error('Close the open live positions before switching mode'), { status: 400 });
    if (mode === 'real' && confirm !== s.name) throw Object.assign(new Error('Type the strategy name to confirm real money'), { status: 400 });
    for (const a of s.assets) await K.resolvePair(a); // every asset must exist on Kraken
    const allocationUsd = Number(promo.tierUsd) || 250;
    if (mode === 'real') {
      const bal = await K.quoteBalance(this.config.kraken, 'USD');
      if (bal < allocationUsd) throw Object.assign(new Error(`Kraken USD balance $${bal.toFixed(2)} is below the $${allocationUsd} allocation`), { status: 400 });
    }
    this.state.live[name] = L.newLive({ allocationUsd, mode, rules: this.rules() });
    this.setStrategyStatus(name, 'running'); this.save();
    this.note(`[[${name}]] ${mode === 'real' ? 'REAL MONEY ENABLED' : 'Kraken validate mode enabled'} · allocation $${allocationUsd} · ${this.config.mode} mode`);
    return this.state.live[name];
  }
  async disableLive(name) {
    const s = this.strategy(name), live = this.liveOf(name);
    if (!live) throw Object.assign(new Error('Not live'), { status: 400 });
    if (this.locks.has(name)) throw Object.assign(new Error('A decision is running; try again in a moment'), { status: 409 });
    for (const a of Object.keys(live.account.positions)) this.recordClose(s, await L.closeLive({ creds: this.creds(), live, asset: a, reason: 'back to paper by you', rules: this.rules() }));
    live.enabled = false; live.stoppedReason = 'by you'; this.save();
    this.note(`[[${name}]] back to paper by you · live positions closed`);
  }

  async closeAll(name) {
    if (this.liveOf(name)) await this.disableLive(name);
    const s = this.strategy(name), acc = this.account(name), rules = this.rules();
    for (const a of Object.keys(acc.positions)) this.recordClose(s, T.closePosition(acc, a, await getPrice(a), 'closed by you', rules));
    this.stop(name); this.save();
  }
  resetAccount(name) {
    this.strategy(name);
    if (this.locks.has(name)) throw Object.assign(new Error('A decision is running; try again in a moment'), { status: 409 });
    if (Object.keys(this.account(name).positions).length) throw Object.assign(new Error('Close the open positions first'), { status: 400 });
    if (this.liveOf(name)) throw Object.assign(new Error('Send the strategy back to paper first'), { status: 400 });
    this.state.accounts[name] = T.newAccount(this.rules()); delete this.state.promotions[name]; this.save();
    this.note(`[[${name}]] paper account reset`);
  }

  evaluation(name) { return T.evaluate(this.account(name), this.rules()); }

  promotion(name, action) {
    this.strategy(name);
    const ev = this.evaluation(name);
    const cur = this.state.promotions[name];
    if (action === 'request') {
      if (!ev.eligible) throw Object.assign(new Error('The strategy has not beaten all your marks yet'), { status: 400 });
      this.state.promotions[name] = { status: 'requested', at: new Date().toISOString(), tierUsd: Number(this.rules().first_tier_usd) || 250, evaluation: ev.checks };
    } else if (action === 'approve') {
      if (cur?.status !== 'requested') throw Object.assign(new Error('Nothing to approve'), { status: 400 });
      if (!ev.eligible) throw Object.assign(new Error('The strategy no longer meets your marks'), { status: 400 });
      this.state.promotions[name] = { ...cur, status: 'approved', approvedAt: new Date().toISOString() };
    } else if (action === 'reject') {
      if (!cur) throw Object.assign(new Error('Nothing to reject'), { status: 400 });
      this.state.promotions[name] = { ...cur, status: 'rejected', rejectedAt: new Date().toISOString() };
    } else throw Object.assign(new Error('Unknown action'), { status: 400 });
    this.save();
    this.note(`[[${name}]] promotion ${action}${action === 'approve' ? ` · $${cur.tierUsd} tier approved; go live from the strategy page` : ''}`);
    return this.state.promotions[name];
  }

  async strategyView(name) {
    const s = this.strategy(name), acc = this.account(name);
    const prices = {};
    for (const a of Object.keys(acc.positions)) { try { prices[a] = await getPrice(a); } catch { /* offline */ } }
    const { body, ...meta } = s;
    const lv = this.state.live[name] || null;
    let live = null;
    if (lv) {
      const lp = {};
      for (const a of Object.keys(lv.account.positions)) { try { lp[a] = (await K.ticker(a)).bid; } catch { /* offline */ } }
      live = { ...lv, equity: +T.equity(lv.account, lp).toFixed(2), prices: lp, metrics: T.metrics(lv.account.trades, lv.allocationUsd) };
    }
    return { ...meta, body, equity: +T.equity(acc, prices).toFixed(2), account: acc, prices, evaluation: T.evaluate(acc, this.rules()), promotion: this.state.promotions[name] || null,
      live, exchange: { connected: !!this.config.kraken } };
  }
}
