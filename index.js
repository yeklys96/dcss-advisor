/**
 * DCSSAdvisor — DWEM Module
 * crawl.nemelex.cards 전용 AI 조언 패널
 *
 * 의존: IOHook:1.0
 * Ollama 설정: OLLAMA_ORIGINS=https://crawl.nemelex.cards 환경변수 필요
 *   예) $env:OLLAMA_ORIGINS="https://crawl.nemelex.cards"; ollama serve
 */

export default class DCSSAdvisor {
    static name = 'DCSSAdvisor';
    static version = '1.0';
    static dependencies = ['IOHook:1.0'];
    static description = 'AI DCSS 게임 조언 패널 (Gemini / OpenRouter / Ollama)';

    // ─── 설정 (localStorage 에 저장됨) ───────────────────────────────────
    #cfg = {
        provider: 'openrouter',          // 'gemini' | 'openrouter' | 'ollama'
        apiKey: '',                      // Gemini API 키 (aistudio.google.com/apikey)
        geminiModel: 'gemini-2.0-flash', // 무료: gemini-2.0-flash, gemini-1.5-flash
        openrouterKey: '',               // OpenRouter API 키 (openrouter.ai/keys)
        openrouterModel: 'google/gemini-2.0-flash-exp:free', // 무료 모델
        ollamaUrl: 'http://localhost:11434',
        ollamaModel: 'qwen2.5:3b-instruct',
        autoAdvice: true,
        cooldownMs: 10000,
        maxLogLines: 30,
        lang: 'ko',
    };

    // ─── 상태 ─────────────────────────────────────────────────────────────
    #state = {
        player: null,        // player 메시지 누적 객체
        inv: {},             // slot→item 인벤토리 (inv 메시지)
        spells: [],          // 배운 마법 목록 (spells 메시지)
        log: [],             // 최근 게임 로그 텍스트
        lastAdviceAt: 0,
        busy: false,
    };

    #panel = null;           // 패널 DOM 요소

    // ─── 진입점 ───────────────────────────────────────────────────────────
    onLoad() {
        this.#loadConfig();
        this.#buildPanel();

        const { IOHook } = DWEM.Modules;
        IOHook.handle_message.after.addHandler('DCSSAdvisor', (msg) => {
            this.#onMessage(msg);
        });
    }

    // ─── WebSocket 메시지 처리 ────────────────────────────────────────────
    #onMessage(raw) {
        try {
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const list = Array.isArray(data.msgs) ? data.msgs : [data];
            for (const m of list) {
                this.#dispatch(m);
            }
        } catch (_) { /* JSON 파싱 실패 무시 */ }
    }

    #dispatch(m) {
        switch (m.msg) {
            // 플레이어 스탯 갱신
            case 'player':
                this.#state.player = Object.assign(this.#state.player ?? {}, m);
                break;

            // 게임 로그 메시지
            case 'msgs': {
                const lines = (m.messages ?? []).map(x => x.text ?? '').filter(Boolean);
                this.#appendLog(lines);
                if (this.#cfg.autoAdvice && lines.some(l => this.#isSignificant(l))) {
                    this.#scheduleAdvice();
                }
                break;
            }

            // 인벤토리 갱신
            case 'inv': {
                const items = m.items ?? [];
                for (const item of items) {
                    if (item.slot != null) {
                        if (item.base_type === 0 && item.name === '') {
                            delete this.#state.inv[item.slot]; // 빈 슬롯 제거
                        } else {
                            this.#state.inv[item.slot] = item.name ?? item.id ?? String(item.slot);
                        }
                    }
                }
                break;
            }

            // 마법 목록 갱신
            case 'spells':
                this.#state.spells = (m.spells ?? []).map(s => {
                    const level = s.level ?? '';
                    const fail = s.fail != null ? ` (실패율 ${s.fail}%)` : '';
                    return `${s.title ?? s.name ?? '?'} Lv${level}${fail}`;
                });
                break;

            // 새 레벨 진입 등 dungeon level 변경
            case 'update_level_data':
            case 'level_change':
                if (this.#cfg.autoAdvice) this.#scheduleAdvice();
                break;

            default:
                break;
        }
    }

    #appendLog(lines) {
        const max = this.#cfg.maxLogLines;
        this.#state.log.push(...lines);
        if (this.#state.log.length > max) {
            this.#state.log = this.#state.log.slice(-max);
        }
    }

    /** 즉각 조언이 필요한 이벤트 키워드 */
    #isSignificant(text) {
        const kw = [
            'dies', 'killed', 'You die', 'You are', 'You have', 'You feel',
            'danger', 'paralysed', 'confusion', 'poisoned', 'cursed', 'found',
            'level up', 'You are now', 'HP:', 'LOW HP', 'reached', 'enters',
            '죽었습니다', '레벨업', '발견했습니다', '위험',
        ];
        return kw.some(k => text.includes(k));
    }

    // ─── 조언 요청 스로틀링 ───────────────────────────────────────────────
    #scheduleAdvice() {
        const now = Date.now();
        if (this.#state.busy) return;
        if (now - this.#state.lastAdviceAt < this.#cfg.cooldownMs) return;
        this.#requestAdvice();
    }

    // ─── AI API 호출 (provider에 따라 분기) ──────────────────────────────
    async #requestAdvice() {
        if (this.#state.busy) return;
        this.#state.busy = true;
        this.#state.lastAdviceAt = Date.now();
        this.#setStatus('⏳ 분석 중…');

        const prompt = this.#buildPrompt();
        try {
            const advice = this.#cfg.provider === 'gemini'
                ? await this.#callGemini(prompt)
                : this.#cfg.provider === 'openrouter'
                ? await this.#callOpenRouter(prompt)
                : await this.#callOllama(prompt);
            this.#showAdvice(advice);
        } catch (err) {
            this.#setStatus(`❌ 오류: ${err.message}`);
        } finally {
            this.#state.busy = false;
        }
    }

    async #callGemini(userPrompt) {
        if (!this.#cfg.apiKey) throw new Error('Gemini API 키가 설정되지 않았습니다. ⚙ 버튼에서 입력하세요.');
        const systemText = this.#cfg.lang === 'ko'
            ? 'DCSS(Dungeon Crawl Stone Soup) 전문가입니다. 현재 상황을 분석하고 즉시 실행 가능한 전술·전략 조언을 한국어로 3~5 문장으로 알려주세요.'
            : 'You are a DCSS expert. Analyze the current situation and give 3-5 concise tactical/strategic tips in English.';
        const model = this.#cfg.geminiModel || 'gemini-2.0-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.#cfg.apiKey}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemText }] },
                contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
                generationConfig: { maxOutputTokens: 2048 },
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
        }
        const json = await res.json();
        return json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '응답을 받지 못했습니다.';
    }

    async #callOpenRouter(userPrompt) {
        if (!this.#cfg.openrouterKey) throw new Error('OpenRouter API 키가 설정되지 않았습니다. ⚙ 버튼에서 입력하세요.');
        const systemText = this.#cfg.lang === 'ko'
            ? 'DCSS(Dungeon Crawl Stone Soup) 전문가입니다. 현재 상황을 분석하고 즉시 실행 가능한 전술·전략 조언을 한국어로 3~5 문장으로 알려주세요.'
            : 'You are a DCSS expert. Analyze the current situation and give 3-5 concise tactical/strategic tips in English.';
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.#cfg.openrouterKey}`,
            },
            body: JSON.stringify({
                model: this.#cfg.openrouterModel || 'google/gemini-2.0-flash-exp:free',
                messages: [
                    { role: 'system', content: systemText },
                    { role: 'user', content: userPrompt },
                ],
                max_tokens: 2048,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
        }
        const json = await res.json();
        return json?.choices?.[0]?.message?.content ?? '응답을 받지 못했습니다.';
    }

    async #callOllama(userPrompt) {
        const systemText = this.#cfg.lang === 'ko'
            ? 'DCSS(Dungeon Crawl Stone Soup) 전문가입니다. 현재 상황을 분석하고 즉시 실행 가능한 전술·전략 조언을 한국어로 3~5 문장으로 알려주세요.'
            : 'You are a DCSS expert. Analyze the current situation and give 3-5 concise tactical/strategic tips in English.';
        const res = await fetch(`${this.#cfg.ollamaUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.#cfg.ollamaModel,
                stream: false,
                messages: [
                    { role: 'system', content: systemText },
                    { role: 'user', content: userPrompt },
                ],
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return json?.message?.content ?? '응답을 받지 못했습니다.';
    }

    #buildPrompt() {
        const p = this.#state.player;
        const log = this.#state.log.slice(-15).join('\n');

        const stats = p
            ? [
                `이름: ${p.name ?? '?'}  종족/직업: ${p.species ?? '?'} ${p.background ?? '?'}`,
                `레벨: XL${p.xl ?? '?'}`,
                `HP: ${p.hp ?? '?'}/${p.mhp ?? '?'}  MP: ${p.mp ?? '?'}/${p.mmp ?? '?'}`,
                `AC: ${p.ac ?? '?'}  EV: ${p.ev ?? '?'}  SH: ${p.sh ?? '?'}`,
                `위치: ${p.place ?? '?'}`,
                `신: ${p.god ?? '없음'}${p.piety != null ? ` (경건도 ${p.piety})` : ''}`,
                `골드: ${p.gold ?? '?'}`,
                `상태이상: ${(p.status ?? []).map(s => s.light ?? s.text ?? s).join(', ') || '없음'}`,
            ].join('\n')
            : '플레이어 정보 없음 (아직 게임 시작 전)';

        // 스킬 (player 메시지에 포함된 경우)
        const skills = (() => {
            const raw = p?.skills ?? [];
            if (!raw.length) return '(없음)';
            return raw
                .filter(s => (s.level ?? 0) > 0)
                .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
                .slice(0, 12)
                .map(s => `${s.name ?? s.id ?? '?'} Lv${s.level ?? 0}`)
                .join(', ') || '(없음)';
        })();

        // 마법
        const spells = this.#state.spells.length
            ? this.#state.spells.slice(0, 12).join(', ')
            : '(없음)';

        // 인벤토리
        const inventory = Object.values(this.#state.inv);
        const invText = inventory.length
            ? inventory.slice(0, 20).join(', ')
            : '(없음)';

        return [
            '[현재 캐릭터 상태]',
            stats,
            '',
            '[스킬]',
            skills,
            '',
            '[배운 마법]',
            spells,
            '',
            '[인벤토리]',
            invText,
            '',
            '[최근 게임 로그]',
            log || '(없음)',
        ].join('\n');
    }

    // ─── UI 구축 ─────────────────────────────────────────────────────────
    #buildPanel() {
        const style = document.createElement('style');
        style.textContent = `
            #dcss-advisor-panel {
                position: fixed;
                bottom: 12px;
                right: 12px;
                width: 340px;
                max-height: 480px;
                display: flex;
                flex-direction: column;
                background: rgba(10, 10, 18, 0.92);
                border: 1px solid #5a3e7a;
                border-radius: 8px;
                font-family: 'Noto Sans KR', sans-serif;
                font-size: 13px;
                color: #e0d8f0;
                box-shadow: 0 4px 24px rgba(0,0,0,0.7);
                z-index: 99999;
                resize: both;
                overflow: hidden;
                min-width: 260px;
                min-height: 100px;
            }
            #dcss-advisor-panel.minimized { max-height: 38px; }
            #dcss-advisor-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 6px 10px;
                background: #2a1a3a;
                border-radius: 8px 8px 0 0;
                cursor: move;
                user-select: none;
                flex-shrink: 0;
            }
            #dcss-advisor-header span { font-weight: bold; color: #c09cf0; }
            #dcss-advisor-header .hbtns { display: flex; gap: 4px; }
            #dcss-advisor-header button {
                background: none;
                border: 1px solid #5a3e7a;
                border-radius: 4px;
                color: #c09cf0;
                padding: 1px 6px;
                cursor: pointer;
                font-size: 12px;
            }
            #dcss-advisor-header button:hover { background: #3a2a5a; }
            #dcss-advisor-body {
                flex: 1;
                min-height: 80px;
                max-height: 300px;
                overflow-y: auto;
                padding: 8px 10px;
                white-space: pre-wrap;
                line-height: 1.5;
                color: #d0e8d0;
            }
            #dcss-advisor-footer {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 5px 8px;
                border-top: 1px solid #3a2a5a;
                flex-shrink: 0;
            }
            #dcss-advisor-footer button {
                flex: 1;
                padding: 3px 0;
                border: 1px solid #5a3e7a;
                border-radius: 4px;
                background: #1e1030;
                color: #c09cf0;
                cursor: pointer;
                font-size: 12px;
            }
            #dcss-advisor-footer button:hover { background: #3a1a6a; }
            #dcss-advisor-footer button.active { background: #4a1a8a; }
            #dcss-advisor-status {
                font-size: 11px;
                color: #888;
                padding: 0 10px 4px;
                flex-shrink: 0;
            }
            #dcss-advisor-cfg {
                padding: 8px 10px;
                display: none;
                flex-direction: column;
                gap: 4px;
                border-top: 1px solid #3a2a5a;
                font-size: 12px;
            }
            #dcss-advisor-cfg.open { display: flex; }
            #dcss-advisor-cfg label { color: #aaa; }
            #dcss-advisor-cfg input, #dcss-advisor-cfg select {
                background: #111;
                border: 1px solid #444;
                border-radius: 3px;
                color: #ddd;
                padding: 2px 5px;
                width: 100%;
                box-sizing: border-box;
            }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'dcss-advisor-panel';
        panel.innerHTML = `
            <div id="dcss-advisor-header">
                <span>🔮 DCSS Advisor</span>
                <div class="hbtns">
                    <button id="dcss-adv-settings-btn" title="설정">⚙</button>
                    <button id="dcss-adv-min-btn" title="최소화">_</button>
                </div>
            </div>
            <div id="dcss-advisor-cfg">
                <label>AI 제공자</label>
                <select id="dcss-adv-provider">
                    <option value="openrouter" ${this.#cfg.provider === 'openrouter' ? 'selected' : ''}>OpenRouter (무료 글로벌)</option>
                    <option value="gemini" ${this.#cfg.provider === 'gemini' ? 'selected' : ''}>Gemini (무료)</option>
                    <option value="ollama" ${this.#cfg.provider === 'ollama' ? 'selected' : ''}>Ollama (로컬)</option>
                </select>
                <div id="dcss-adv-openrouter-cfg" style="display:${this.#cfg.provider === 'openrouter' ? 'contents' : 'none'}">
                    <label>OpenRouter API 키 <a href="https://openrouter.ai/keys" target="_blank" style="color:#9cf;font-size:10px">발급</a></label>
                    <input id="dcss-adv-orkey" type="password" value="${this.#cfg.openrouterKey}" placeholder="sk-or-..." />
                    <label>모델</label>
                    <input id="dcss-adv-or-model" type="text" value="${this.#cfg.openrouterModel}" />
                </div>
                <div id="dcss-adv-gemini-cfg" style="display:${this.#cfg.provider === 'gemini' ? 'contents' : 'none'}">
                    <label>Gemini API 키 <a href="https://aistudio.google.com/apikey" target="_blank" style="color:#9cf;font-size:10px">발급</a></label>
                    <input id="dcss-adv-apikey" type="password" value="${this.#cfg.apiKey}" placeholder="AIza..." />
                    <label>모델</label>
                    <input id="dcss-adv-gemini-model" type="text" value="${this.#cfg.geminiModel}" />
                </div>
                <div id="dcss-adv-ollama-cfg" style="display:${this.#cfg.provider === 'ollama' ? 'contents' : 'none'}">
                    <label>Ollama URL</label>
                    <input id="dcss-adv-url" type="text" value="${this.#cfg.ollamaUrl}" />
                    <label>모델</label>
                    <input id="dcss-adv-ollama-model" type="text" value="${this.#cfg.ollamaModel}" />
                </div>
                <label>언어</label>
                <select id="dcss-adv-lang">
                    <option value="ko" ${this.#cfg.lang === 'ko' ? 'selected' : ''}>한국어</option>
                    <option value="en" ${this.#cfg.lang === 'en' ? 'selected' : ''}>English</option>
                </select>
                <button id="dcss-adv-save-btn">저장</button>
            </div>
            <div id="dcss-advisor-body">아직 조언이 없습니다.\n게임을 시작하면 자동으로 분석합니다.</div>
            <div id="dcss-advisor-status"></div>
            <div id="dcss-advisor-footer">
                <button id="dcss-adv-auto-btn" class="${this.#cfg.autoAdvice ? 'active' : ''}">
                    자동 ${this.#cfg.autoAdvice ? 'ON' : 'OFF'}
                </button>
                <button id="dcss-adv-ask-btn">지금 조언 받기</button>
            </div>
        `;
        document.body.appendChild(panel);
        this.#panel = panel;

        // 버튼 이벤트
        panel.querySelector('#dcss-adv-min-btn').addEventListener('click', () => {
            panel.classList.toggle('minimized');
        });

        panel.querySelector('#dcss-adv-settings-btn').addEventListener('click', () => {
            panel.querySelector('#dcss-advisor-cfg').classList.toggle('open');
        });

        // 제공자 변경 시 관련 필드 표시/숨김
        panel.querySelector('#dcss-adv-provider').addEventListener('change', (e) => {
            const v = e.target.value;
            panel.querySelector('#dcss-adv-openrouter-cfg').style.display = v === 'openrouter' ? 'contents' : 'none';
            panel.querySelector('#dcss-adv-gemini-cfg').style.display = v === 'gemini' ? 'contents' : 'none';
            panel.querySelector('#dcss-adv-ollama-cfg').style.display = v === 'ollama' ? 'contents' : 'none';
        });

        panel.querySelector('#dcss-adv-save-btn').addEventListener('click', () => {
            this.#cfg.provider = panel.querySelector('#dcss-adv-provider').value;
            this.#cfg.openrouterKey = panel.querySelector('#dcss-adv-orkey').value.trim();
            this.#cfg.openrouterModel = panel.querySelector('#dcss-adv-or-model').value.trim();
            this.#cfg.apiKey = panel.querySelector('#dcss-adv-apikey').value.trim();
            this.#cfg.geminiModel = panel.querySelector('#dcss-adv-gemini-model').value.trim();
            this.#cfg.ollamaUrl = panel.querySelector('#dcss-adv-url').value.trim().replace(/\/$/, '');
            this.#cfg.ollamaModel = panel.querySelector('#dcss-adv-ollama-model').value.trim();
            this.#cfg.lang = panel.querySelector('#dcss-adv-lang').value;
            this.#saveConfig();
            panel.querySelector('#dcss-advisor-cfg').classList.remove('open');
            this.#setStatus('✅ 설정 저장됨');
        });

        panel.querySelector('#dcss-adv-auto-btn').addEventListener('click', () => {
            this.#cfg.autoAdvice = !this.#cfg.autoAdvice;
            const btn = panel.querySelector('#dcss-adv-auto-btn');
            btn.textContent = `자동 ${this.#cfg.autoAdvice ? 'ON' : 'OFF'}`;
            btn.classList.toggle('active', this.#cfg.autoAdvice);
            this.#saveConfig();
        });

        panel.querySelector('#dcss-adv-ask-btn').addEventListener('click', () => {
            this.#requestAdvice();
        });

        // 드래그 이동
        this.#makeDraggable(panel, panel.querySelector('#dcss-advisor-header'));
    }

    #makeDraggable(el, handle) {
        let dx = 0, dy = 0, mx = 0, my = 0;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            mx = e.clientX;
            my = e.clientY;
            const onMove = (e) => {
                dx = mx - e.clientX;
                dy = my - e.clientY;
                mx = e.clientX;
                my = e.clientY;
                el.style.top = (el.offsetTop - dy) + 'px';
                el.style.right = '';
                el.style.left = (el.offsetLeft - dx) + 'px';
                el.style.bottom = '';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    #showAdvice(text) {
        if (!this.#panel) return;
        this.#panel.querySelector('#dcss-advisor-body').textContent = text;
        this.#setStatus(`✅ ${new Date().toLocaleTimeString()} 갱신`);
    }

    #setStatus(msg) {
        if (!this.#panel) return;
        this.#panel.querySelector('#dcss-advisor-status').textContent = msg;
    }

    // ─── 설정 저장/불러오기 ───────────────────────────────────────────────
    #loadConfig() {
        try {
            const saved = JSON.parse(localStorage.getItem('DCSS_ADVISOR_CFG') ?? '{}');
            Object.assign(this.#cfg, saved);
        } catch (_) { /* 무시 */ }
    }

    #saveConfig() {
        localStorage.setItem('DCSS_ADVISOR_CFG', JSON.stringify(this.#cfg));
    }
}
