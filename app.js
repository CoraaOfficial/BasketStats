(() => {
  'use strict';

  const STORAGE_TEAM_KEY = 'basketstats_saved_team_v1';
  const STORAGE_ACTIVE_KEY = 'basketstats_active_match_v1';
  const STORAGE_HISTORY_KEY = 'basketstats_history_v1';

  const STAT_LABELS = {
    FTM: 'Tiro Libero Segnato (+1)',
    FTA_MISS: 'Tiro Libero Sbagliato',
    FG2M: 'Tiro da 2 Segnato (+2)',
    FG2_MISS: 'Tiro da 2 Sbagliato',
    FG3M: 'Tiro da 3 Segnato (+3)',
    FG3_MISS: 'Tiro da 3 Sbagliato',
    DREB: 'Rimbalzo Difensivo',
    OREB: 'Rimbalzo Offensivo',
    AST: 'Assist',
    STL: 'Palla Recuperata',
    TOV: 'Palla Persa',
    BLK: 'Stoppata',
    PF: 'Fallo Fatto',
    PFD: 'Fallo Subito',
    OPP_PTS: 'Punti Avversari',
    OPP_FOUL: 'Fallo Avversari',
    HOME_TO: 'Timeout Tua Squadra',
    AWAY_TO: 'Timeout Avversari'
  };

  // ==================== STATE ====================
  let savedTeam = loadJSON(STORAGE_TEAM_KEY, {
    homeName: '',
    homeColor: '#f97316',
    roster: []
  });

  let matchHistory = loadJSON(STORAGE_HISTORY_KEY, []);
  let activeMatch = loadJSON(STORAGE_ACTIVE_KEY, null);
  let viewingHistoryMatch = null;

  let selectedPlayerId = null;
  let subMode = false;
  let subFirstPick = null; // { id, onCourt }

  let clockInterval = null;
  let clockLastTick = null;

  // ==================== DOM HELPERS ====================
  const $ = (id) => document.getElementById(id);

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('localStorage error:', e);
    }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function formatClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function quarterLabel(q) {
    return q <= 4 ? `Q${q}` : `OT${q - 4}`;
  }

  function pct(made, att) {
    if (!att) return '0%';
    return `${Math.round((made / att) * 100)}%`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==================== SERVICE WORKER ====================
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // ==================== SETUP VIEW ====================
  function initSetupView() {
    $('home-name').value = savedTeam.homeName || '';
    $('home-color').value = savedTeam.homeColor || '#f97316';
    renderSetupRoster();
    renderHistoryList();
    updateResumeBanner();
  }

  function persistSavedTeam() {
    savedTeam.homeName = $('home-name').value.trim();
    savedTeam.homeColor = $('home-color').value;
    saveJSON(STORAGE_TEAM_KEY, savedTeam);
  }

  function updateResumeBanner() {
    const banner = $('resume-banner');
    if (activeMatch && !activeMatch.finished) {
      const stats = computeMatchStats(activeMatch);
      $('resume-summary').textContent =
        `${activeMatch.homeName} ${stats.homeScore} - ${stats.awayScore} ${activeMatch.awayName} (${quarterLabel(activeMatch.quarter)} ${formatClock(activeMatch.clockSeconds)})`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  function renderSetupRoster() {
    const container = $('setup-roster-list');
    const sorted = [...savedTeam.roster].sort((a, b) => Number(a.number) - Number(b.number));
    const starterCount = sorted.filter((p) => p.starter).length;
    $('starter-count-pill').textContent = `${starterCount} / 5 in quintetto`;

    if (sorted.length === 0) {
      container.innerHTML = '<p class="empty-hint">Nessun giocatore inserito. Aggiungi i giocatori con numero e nome qui sopra.</p>';
      return;
    }

    container.innerHTML = sorted
      .map(
        (p) => `
      <div class="roster-row" data-id="${p.id}">
        <div class="roster-row-left">
          <span class="jersey-badge">#${escapeHtml(p.number)}</span>
          <span class="roster-player-name">${escapeHtml(p.name)}</span>
        </div>
        <div class="roster-row-actions">
          <button type="button" class="starter-toggle ${p.starter ? 'active' : ''}" data-action="toggle-starter" data-id="${p.id}">
            ${p.starter ? '★ In Quintetto' : 'Panchina'}
          </button>
          <button type="button" class="btn-icon-xs text-danger" data-action="delete-player" data-id="${p.id}" title="Rimuovi">✕</button>
        </div>
      </div>`
      )
      .join('');
  }

  function renderHistoryList() {
    const list = $('history-list');
    $('history-count').textContent = String(matchHistory.length);

    if (matchHistory.length === 0) {
      list.innerHTML = '<p class="empty-hint">Nessuna partita salvata. A fine partita potrai salvarla qui.</p>';
      return;
    }

    list.innerHTML = matchHistory
      .map((m, idx) => {
        const st = computeMatchStats(m);
        const dateStr = new Date(m.createdAt).toLocaleDateString('it-IT', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric'
        });
        return `
        <div class="history-item">
          <div>
            <div class="history-score">${escapeHtml(m.homeName)} ${st.homeScore} - ${st.awayScore} ${escapeHtml(m.awayName)}</div>
            <div class="history-meta">${dateStr} • ${m.events.length} eventi</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn btn-ghost btn-xs" data-history-open="${idx}">Tabellino</button>
            <button type="button" class="btn-icon-xs text-danger" data-history-del="${idx}" title="Elimina">✕</button>
          </div>
        </div>`;
      })
      .join('');
  }

  // ==================== STATS ENGINE ====================
  function createEmptyPlayerStats(player) {
    return {
      id: player.id,
      number: player.number,
      name: player.name,
      pts: 0,
      ftm: 0,
      fta: 0,
      fg2m: 0,
      fg2a: 0,
      fg3m: 0,
      fg3a: 0,
      oreb: 0,
      dreb: 0,
      reb: 0,
      ast: 0,
      stl: 0,
      tov: 0,
      blk: 0,
      pf: 0,
      pfd: 0,
      val: 0
    };
  }

  function computeMatchStats(match) {
    const maxQ = Math.max(4, match.quarter || 4, ...match.events.map((e) => e.quarter || 1));
    const qHome = Array(maxQ).fill(0);
    const qAway = Array(maxQ).fill(0);
    const foulsHome = Array(maxQ).fill(0);
    const foulsAway = Array(maxQ).fill(0);

    let homeTimeouts = 0;
    let awayTimeouts = 0;

    const playerMap = {};
    match.players.forEach((p) => {
      playerMap[p.id] = createEmptyPlayerStats(p);
    });

    for (const ev of match.events) {
      const qi = Math.max(0, (ev.quarter || 1) - 1);
      const ps = ev.playerId ? playerMap[ev.playerId] : null;

      switch (ev.type) {
        case 'FTM':
          if (ps) { ps.ftm++; ps.fta++; ps.pts += 1; }
          qHome[qi] += 1;
          break;
        case 'FTA_MISS':
          if (ps) { ps.fta++; }
          break;
        case 'FG2M':
          if (ps) { ps.fg2m++; ps.fg2a++; ps.pts += 2; }
          qHome[qi] += 2;
          break;
        case 'FG2_MISS':
          if (ps) { ps.fg2a++; }
          break;
        case 'FG3M':
          if (ps) { ps.fg3m++; ps.fg3a++; ps.pts += 3; }
          qHome[qi] += 3;
          break;
        case 'FG3_MISS':
          if (ps) { ps.fg3a++; }
          break;
        case 'DREB':
          if (ps) { ps.dreb++; ps.reb++; }
          break;
        case 'OREB':
          if (ps) { ps.oreb++; ps.reb++; }
          break;
        case 'AST':
          if (ps) { ps.ast++; }
          break;
        case 'STL':
          if (ps) { ps.stl++; }
          break;
        case 'TOV':
          if (ps) { ps.tov++; }
          break;
        case 'BLK':
          if (ps) { ps.blk++; }
          break;
        case 'PF':
          if (ps) { ps.pf++; }
          foulsHome[qi] += 1;
          break;
        case 'PFD':
          if (ps) { ps.pfd++; }
          break;
        case 'OPP_PTS':
          qAway[qi] = Math.max(0, qAway[qi] + (ev.value || 0));
          break;
        case 'OPP_FOUL':
          foulsAway[qi] = Math.max(0, foulsAway[qi] + (ev.value || 1));
          break;
        case 'HOME_TO':
          homeTimeouts = Math.max(0, homeTimeouts + (ev.value || 1));
          break;
        case 'AWAY_TO':
          awayTimeouts = Math.max(0, awayTimeouts + (ev.value || 1));
          break;
      }
    }

    const playersList = Object.values(playerMap).map((ps) => {
      const missedFG = (ps.fg2a - ps.fg2m) + (ps.fg3a - ps.fg3m);
      const missedFT = ps.fta - ps.ftm;
      ps.val = (ps.pts + ps.reb + ps.ast + ps.stl + ps.blk + ps.pfd) - (missedFG + missedFT + ps.tov + ps.pf);
      return ps;
    });

    const totals = playersList.reduce(
      (acc, p) => {
        acc.pts += p.pts;
        acc.ftm += p.ftm;
        acc.fta += p.fta;
        acc.fg2m += p.fg2m;
        acc.fg2a += p.fg2a;
        acc.fg3m += p.fg3m;
        acc.fg3a += p.fg3a;
        acc.oreb += p.oreb;
        acc.dreb += p.dreb;
        acc.reb += p.reb;
        acc.ast += p.ast;
        acc.stl += p.stl;
        acc.tov += p.tov;
        acc.blk += p.blk;
        acc.pf += p.pf;
        acc.pfd += p.pfd;
        acc.val += p.val;
        return acc;
      },
      createEmptyPlayerStats({ id: 'tot', number: '', name: 'TOTALI' })
    );

    const homeScore = qHome.reduce((a, b) => a + b, 0);
    const awayScore = qAway.reduce((a, b) => a + b, 0);

    return {
      homeScore,
      awayScore,
      qHome,
      qAway,
      foulsHome,
      foulsAway,
      homeTimeouts,
      awayTimeouts,
      playersList,
      playerMap,
      totals
    };
  }

  function getMaxTimeoutsForHalf(match) {
    if (match.rules.timeoutRule === 'free') return 5;
    if (match.rules.timeoutRule === '3-3') return 3;
    // FIBA: 2 in first half (Q1-Q2), 3 in second half (Q3-Q4+)
    return match.quarter <= 2 ? 2 : 3;
  }

  // ==================== LIVE MATCH VIEW ====================
  function startNewMatch() {
    persistSavedTeam();
    const homeName = $('home-name').value.trim() || 'Tua Squadra';
    const awayName = $('away-name').value.trim() || 'Avversari';
    const validationMsg = $('start-validation-msg');

    if (savedTeam.roster.length === 0) {
      validationMsg.textContent = 'Aggiungi almeno un giocatore nella rosa prima di iniziare.';
      validationMsg.classList.remove('hidden');
      return;
    }
    validationMsg.classList.add('hidden');

    const qMin = parseInt($('quarter-minutes').value, 10) || 10;
    const otMin = parseInt($('ot-minutes').value, 10) || 5;
    const bonusFouls = parseInt($('bonus-fouls').value, 10) || 5;
    const timeoutRule = $('timeout-rule').value;

    const sortedRoster = [...savedTeam.roster].sort((a, b) => Number(a.number) - Number(b.number));
    // If user didn't mark any starter, automatically put first 5 on court
    const hasStarters = sortedRoster.some((p) => p.starter);

    activeMatch = {
      id: uid(),
      createdAt: new Date().toISOString(),
      finished: false,
      homeName,
      homeColor: $('home-color').value || '#f97316',
      awayName,
      awayColor: $('away-color').value || '#38bdf8',
      rules: {
        quarterMinutes: qMin,
        otMinutes: otMin,
        bonusFouls,
        timeoutRule
      },
      quarter: 1,
      clockSeconds: qMin * 60,
      players: sortedRoster.map((p, idx) => ({
        id: p.id,
        number: p.number,
        name: p.name,
        onCourt: hasStarters ? Boolean(p.starter) : idx < 5
      })),
      events: []
    };

    selectedPlayerId = activeMatch.players.find((p) => p.onCourt)?.id || activeMatch.players[0]?.id || null;
    subMode = false;
    subFirstPick = null;
    saveActiveMatch();
    openMatchView();
  }

  function saveActiveMatch() {
    if (activeMatch) {
      saveJSON(STORAGE_ACTIVE_KEY, activeMatch);
    }
  }

  function openMatchView() {
    stopClock();
    $('setup-view').classList.remove('active');
    $('match-view').classList.add('active');
    renderMatchView();
  }

  function backToSetup() {
    stopClock();
    saveActiveMatch();
    $('match-view').classList.remove('active');
    $('setup-view').classList.add('active');
    initSetupView();
  }

  function renderMatchView() {
    if (!activeMatch) return;
    const stats = computeMatchStats(activeMatch);
    const qi = activeMatch.quarter - 1;
    const bonusThreshold = activeMatch.rules.bonusFouls;

    // Scoreboard
    $('sb-home-name').textContent = activeMatch.homeName;
    $('sb-away-name').textContent = activeMatch.awayName;
    $('sb-home-bar').style.background = activeMatch.homeColor;
    $('sb-away-bar').style.background = activeMatch.awayColor;
    $('sb-home-score').textContent = stats.homeScore;
    $('sb-away-score').textContent = stats.awayScore;

    // Fouls & Bonus
    const hFouls = stats.foulsHome[qi] || 0;
    const aFouls = stats.foulsAway[qi] || 0;
    $('sb-home-fouls-num').textContent = hFouls;
    $('sb-away-fouls-num').textContent = aFouls;
    $('sb-home-bonus').classList.toggle('hidden', hFouls < bonusThreshold);
    $('sb-away-bonus').classList.toggle('hidden', aFouls < bonusThreshold);

    renderPips($('sb-home-fouls-pips'), hFouls, bonusThreshold, true);
    renderPips($('sb-away-fouls-pips'), aFouls, bonusThreshold, true);

    // Timeouts
    const maxTO = activeMatch.rules.timeoutRule === 'free' ? 5 : 5;
    renderTimeoutPips($('sb-home-to-pips'), stats.homeTimeouts, maxTO);
    renderTimeoutPips($('sb-away-to-pips'), stats.awayTimeouts, maxTO);

    // Clock & Quarter
    $('sb-quarter').textContent = quarterLabel(activeMatch.quarter);
    $('sb-clock').textContent = formatClock(activeMatch.clockSeconds);

    // Undo & Last action
    $('btn-undo').disabled = activeMatch.events.length === 0;
    if (activeMatch.events.length > 0) {
      const last = activeMatch.events[activeMatch.events.length - 1];
      $('last-action-toast').textContent = `Ultimo: ${formatEventDescription(last, activeMatch)}`;
    } else {
      $('last-action-toast').textContent = 'Pronto: seleziona un giocatore e segna una statistica.';
    }

    // Substitution banner
    $('sub-banner').classList.toggle('hidden', !subMode);
    $('btn-sub-mode').classList.toggle('btn-secondary', subMode);

    // Players
    const courtPlayers = activeMatch.players.filter((p) => p.onCourt);
    const benchPlayers = activeMatch.players.filter((p) => !p.onCourt);
    $('on-court-count').textContent = String(courtPlayers.length);
    $('bench-count').textContent = String(benchPlayers.length);

    $('court-players-grid').innerHTML = courtPlayers
      .map((p) => {
        const ps = stats.playerMap[p.id];
        const isSel = selectedPlayerId === p.id && !subMode;
        const isSubPick = subMode && subFirstPick && subFirstPick.id === p.id;
        const fouledOut = ps.pf >= 5;
        return `
        <div class="player-card ${isSel ? 'selected' : ''} ${isSubPick ? 'sub-pick' : ''} ${fouledOut ? 'fouled-out' : ''}" data-player-id="${p.id}">
          <div class="pc-top">
            <div class="pc-identity">
              <span class="pc-num">#${escapeHtml(p.number)}</span>
              <span class="pc-name">${escapeHtml(p.name)}</span>
            </div>
            <span class="pc-pts">${ps.pts}</span>
          </div>
          <div class="pc-stats-row">
            <span>REB <strong>${ps.reb}</strong></span>
            <span>AST <strong>${ps.ast}</strong></span>
            <span>REC <strong>${ps.stl}</strong></span>
            <span>VAL <strong>${ps.val}</strong></span>
          </div>
          <div class="pc-fouls-row">
            <div class="pips">${buildFoulDotsHTML(ps.pf)}</div>
            ${fouledOut ? '<span class="foul-out-tag">5 FALLI</span>' : `<span>${ps.pf}/5 falli</span>`}
          </div>
        </div>`;
      })
      .join('');

    $('bench-players-grid').innerHTML = benchPlayers.length
      ? benchPlayers
          .map((p) => {
            const ps = stats.playerMap[p.id];
            const isSel = selectedPlayerId === p.id && !subMode;
            const isSubPick = subMode && subFirstPick && subFirstPick.id === p.id;
            return `
            <div class="bench-card ${isSel ? 'selected' : ''} ${isSubPick ? 'sub-pick' : ''}" data-player-id="${p.id}">
              <div class="pc-identity">
                <span class="pc-num">#${escapeHtml(p.number)}</span>
                <span class="pc-name">${escapeHtml(p.name)}</span>
              </div>
              <span style="font-size:0.82rem;color:var(--text-muted);font-weight:700;">${ps.pts}p · ${ps.pf}f</span>
            </div>`;
          })
          .join('')
      : '<p class="empty-hint">Nessun giocatore in panchina.</p>';

    // Selected player banner
    const selPlayer = activeMatch.players.find((p) => p.id === selectedPlayerId);
    const banner = $('selected-player-banner');
    if (selPlayer) {
      const ps = stats.playerMap[selPlayer.id];
      banner.classList.remove('empty');
      banner.innerHTML = `
        <div>
          <strong style="font-size:1.05rem;">#${escapeHtml(selPlayer.number)} ${escapeHtml(selPlayer.name)}</strong>
          <span class="pill" style="margin-left:6px;">${selPlayer.onCourt ? 'In Campo' : 'Panchina'}</span>
        </div>
        <div style="font-weight:800;font-size:0.95rem;color:#fdba74;">${ps.pts} PTS · ${ps.reb} REB · ${ps.pf}F</div>
      `;
    } else {
      banner.classList.add('empty');
      banner.innerHTML = '<span class="sel-hint">👆 Tocca un giocatore a sinistra</span>';
    }
  }

  function renderPips(el, count, max, isFoul) {
    let html = '';
    for (let i = 0; i < max; i++) {
      const filled = i < count;
      const cls = filled ? (isFoul && count >= max ? 'filled-danger' : 'filled') : '';
      html += `<span class="pip ${cls}"></span>`;
    }
    el.innerHTML = html;
  }

  function renderTimeoutPips(el, count, max) {
    let html = '';
    for (let i = 0; i < max; i++) {
      html += `<span class="pip ${i < count ? 'to-filled' : ''}"></span>`;
    }
    el.innerHTML = html;
  }

  function buildFoulDotsHTML(fouls) {
    let html = '';
    for (let i = 0; i < 5; i++) {
      const filled = i < fouls;
      const cls = filled ? (fouls >= 4 ? 'filled-danger' : 'filled') : '';
      html += `<span class="pip ${cls}"></span>`;
    }
    return html;
  }

  function formatEventDescription(ev, match) {
    const timePrefix = `${quarterLabel(ev.quarter)} ${formatClock(ev.clockSeconds)}`;
    const player = ev.playerId ? match.players.find((p) => p.id === ev.playerId) : null;
    const pLabel = player ? `#${player.number} ${player.name}` : '';

    if (ev.type === 'OPP_PTS') {
      return `${timePrefix} • ${match.awayName}: ${ev.value > 0 ? '+' : ''}${ev.value} pt`;
    }
    if (ev.type === 'OPP_FOUL') {
      return `${timePrefix} • ${match.awayName}: Fallo (${ev.value > 0 ? '+1' : '-1'})`;
    }
    if (ev.type === 'HOME_TO') {
      return `${timePrefix} • Timeout ${match.homeName}`;
    }
    if (ev.type === 'AWAY_TO') {
      return `${timePrefix} • Timeout ${match.awayName}`;
    }
    return `${timePrefix} • ${pLabel}: ${STAT_LABELS[ev.type] || ev.type}`;
  }

  function recordPlayerStat(statType) {
    if (!activeMatch) return;
    if (!selectedPlayerId) {
      $('selected-player-banner').animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'scale(1)' }],
        { duration: 220 }
      );
      return;
    }

    activeMatch.events.push({
      id: uid(),
      quarter: activeMatch.quarter,
      clockSeconds: activeMatch.clockSeconds,
      playerId: selectedPlayerId,
      type: statType,
      value: 1
    });

    saveActiveMatch();
    renderMatchView();
  }

  function recordTeamEvent(type, value) {
    if (!activeMatch) return;
    activeMatch.events.push({
      id: uid(),
      quarter: activeMatch.quarter,
      clockSeconds: activeMatch.clockSeconds,
      playerId: null,
      type,
      value
    });
    saveActiveMatch();
    renderMatchView();
  }

  function undoLastEvent() {
    if (!activeMatch || activeMatch.events.length === 0) return;
    activeMatch.events.pop();
    saveActiveMatch();
    renderMatchView();
  }

  function handlePlayerTap(playerId) {
    if (!activeMatch) return;
    const tapped = activeMatch.players.find((p) => p.id === playerId);
    if (!tapped) return;

    if (!subMode) {
      selectedPlayerId = playerId;
      renderMatchView();
      return;
    }

    // Substitution mode
    if (!subFirstPick) {
      subFirstPick = { id: tapped.id, onCourt: tapped.onCourt };
      renderMatchView();
      return;
    }

    if (subFirstPick.id === tapped.id) {
      subFirstPick = null;
      renderMatchView();
      return;
    }

    if (subFirstPick.onCourt !== tapped.onCourt) {
      const firstPlayer = activeMatch.players.find((p) => p.id === subFirstPick.id);
      if (firstPlayer) {
        firstPlayer.onCourt = !firstPlayer.onCourt;
        tapped.onCourt = !tapped.onCourt;
        selectedPlayerId = tapped.onCourt ? tapped.id : firstPlayer.id;
      }
      subFirstPick = null;
      saveActiveMatch();
      renderMatchView();
    } else {
      // Same group tapped: switch first pick
      subFirstPick = { id: tapped.id, onCourt: tapped.onCourt };
      renderMatchView();
    }
  }

  // ==================== CLOCK ====================
  function toggleClock() {
    if (!activeMatch) return;
    if (clockInterval) {
      stopClock();
    } else {
      if (activeMatch.clockSeconds <= 0) return;
      clockLastTick = Date.now();
      $('btn-clock-toggle').classList.add('running');
      $('clock-status-label').textContent = 'IN CORSO';
      clockInterval = setInterval(() => {
        const now = Date.now();
        const elapsed = (now - clockLastTick) / 1000;
        if (elapsed >= 1) {
          const whole = Math.floor(elapsed);
          clockLastTick += whole * 1000;
          activeMatch.clockSeconds = Math.max(0, activeMatch.clockSeconds - whole);
          $('sb-clock').textContent = formatClock(activeMatch.clockSeconds);
          if (activeMatch.clockSeconds <= 0) {
            stopClock();
            saveActiveMatch();
          }
        }
      }, 250);
    }
  }

  function stopClock() {
    if (clockInterval) {
      clearInterval(clockInterval);
      clockInterval = null;
    }
    $('btn-clock-toggle').classList.remove('running');
    $('clock-status-label').textContent = 'PAUSA';
    saveActiveMatch();
  }

  function changeQuarter(delta) {
    if (!activeMatch) return;
    const nextQ = Math.max(1, Math.min(8, activeMatch.quarter + delta));
    if (nextQ === activeMatch.quarter) return;
    stopClock();
    activeMatch.quarter = nextQ;
    activeMatch.clockSeconds = (nextQ <= 4 ? activeMatch.rules.quarterMinutes : activeMatch.rules.otMinutes) * 60;
    saveActiveMatch();
    renderMatchView();
  }

  function resetQuarterClock() {
    if (!activeMatch) return;
    stopClock();
    const mins = activeMatch.quarter <= 4 ? activeMatch.rules.quarterMinutes : activeMatch.rules.otMinutes;
    activeMatch.clockSeconds = mins * 60;
    saveActiveMatch();
    renderMatchView();
  }

  // ==================== BOX SCORE & EXPORTS ====================
  function getExportTargetMatch() {
    return viewingHistoryMatch || activeMatch;
  }

  function openBoxScoreModal(match, isFinishing = false) {
    if (!match) return;
    const stats = computeMatchStats(match);

    $('boxscore-title').textContent = `${match.homeName} ${stats.homeScore} — ${stats.awayScore} ${match.awayName}`;
    const dateStr = new Date(match.createdAt).toLocaleString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    $('boxscore-subtitle').textContent = `${quarterLabel(match.quarter)} • ${dateStr}`;
    $('print-match-title').textContent = $('boxscore-title').textContent;
    $('print-match-date').textContent = `Data: ${dateStr}`;

    // Quarter table
    const qHeaders = stats.qHome.map((_, i) => `<th>${quarterLabel(i + 1)}</th>`).join('');
    const hCells = stats.qHome.map((v) => `<td>${v}</td>`).join('');
    const aCells = stats.qAway.map((v) => `<td>${v}</td>`).join('');
    $('quarter-table').innerHTML = `
      <thead>
        <tr><th>Squadra</th>${qHeaders}<th>TOT</th></tr>
      </thead>
      <tbody>
        <tr><td><strong>${escapeHtml(match.homeName)}</strong></td>${hCells}<td><strong>${stats.homeScore}</strong></td></tr>
        <tr><td><strong>${escapeHtml(match.awayName)}</strong></td>${aCells}<td><strong>${stats.awayScore}</strong></td></tr>
      </tbody>
    `;

    // Shooting summary cards
    const t = stats.totals;
    const fgm = t.fg2m + t.fg3m;
    const fga = t.fg2a + t.fg3a;
    $('team-shooting-cards').innerHTML = `
      <div class="shoot-card">
        <div class="shoot-card-label">DAL CAMPO (FG)</div>
        <div class="shoot-card-val">${pct(fgm, fga)}</div>
        <div class="shoot-card-sub">${fgm}/${fga}</div>
      </div>
      <div class="shoot-card">
        <div class="shoot-card-label">DA 2 PUNTI</div>
        <div class="shoot-card-val">${pct(t.fg2m, t.fg2a)}</div>
        <div class="shoot-card-sub">${t.fg2m}/${t.fg2a}</div>
      </div>
      <div class="shoot-card">
        <div class="shoot-card-label">DA 3 PUNTI</div>
        <div class="shoot-card-val">${pct(t.fg3m, t.fg3a)}</div>
        <div class="shoot-card-sub">${t.fg3m}/${t.fg3a}</div>
      </div>
      <div class="shoot-card">
        <div class="shoot-card-label">TIRI LIBERI</div>
        <div class="shoot-card-val">${pct(t.ftm, t.fta)}</div>
        <div class="shoot-card-sub">${t.ftm}/${t.fta}</div>
      </div>
      <div class="shoot-card">
        <div class="shoot-card-label">RIMBALZI (O/D)</div>
        <div class="shoot-card-val">${t.reb}</div>
        <div class="shoot-card-sub">${t.oreb} Off / ${t.dreb} Dif</div>
      </div>
      <div class="shoot-card">
        <div class="shoot-card-label">VALUTAZIONE</div>
        <div class="shoot-card-val">${t.val}</div>
        <div class="shoot-card-sub">${t.ast} AST · ${t.tov} PER</div>
      </div>
    `;

    // Player table
    const sortedPlayers = [...stats.playersList].sort((a, b) => Number(a.number) - Number(b.number));
    const rowsHTML = sortedPlayers
      .map(
        (p) => `
      <tr>
        <td>#${escapeHtml(p.number)}</td>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td><strong>${p.pts}</strong></td>
        <td>${p.fg2m}/${p.fg2a}</td>
        <td>${p.fg3m}/${p.fg3a}</td>
        <td>${p.ftm}/${p.fta}</td>
        <td>${p.oreb}</td>
        <td>${p.dreb}</td>
        <td><strong>${p.reb}</strong></td>
        <td>${p.ast}</td>
        <td>${p.stl}</td>
        <td>${p.tov}</td>
        <td>${p.blk}</td>
        <td>${p.pf}</td>
        <td>${p.pfd}</td>
        <td><strong>${p.val}</strong></td>
      </tr>`
      )
      .join('');

    $('player-boxscore-table').innerHTML = `
      <thead>
        <tr>
          <th>#</th><th>Giocatore</th><th>PTS</th>
          <th>T2</th><th>T3</th><th>TL</th>
          <th>RO</th><th>RD</th><th>REB</th>
          <th>AST</th><th>REC</th><th>PER</th><th>STP</th>
          <th>FF</th><th>FS</th><th>VAL</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHTML}
        <tr class="totals-row">
          <td></td>
          <td>TOTALI ${escapeHtml(match.homeName)}</td>
          <td>${t.pts}</td>
          <td>${t.fg2m}/${t.fg2a}</td>
          <td>${t.fg3m}/${t.fg3a}</td>
          <td>${t.ftm}/${t.fta}</td>
          <td>${t.oreb}</td>
          <td>${t.dreb}</td>
          <td>${t.reb}</td>
          <td>${t.ast}</td>
          <td>${t.stl}</td>
          <td>${t.tov}</td>
          <td>${t.blk}</td>
          <td>${t.pf}</td>
          <td>${t.pfd}</td>
          <td>${t.val}</td>
        </tr>
      </tbody>
    `;

    $('finish-match-actions').classList.toggle('hidden', !isFinishing || Boolean(viewingHistoryMatch));
    $('boxscore-modal').classList.remove('hidden');
  }

  function exportCSV() {
    const match = getExportTargetMatch();
    if (!match) return;
    const stats = computeMatchStats(match);
    const sep = ';';
    const lines = [];

    lines.push([`Partita`, `${match.homeName} vs ${match.awayName}`].join(sep));
    lines.push([`Risultato`, `${stats.homeScore} - ${stats.awayScore}`].join(sep));
    lines.push([]);
    lines.push(['#', 'Giocatore', 'PTS', 'T2M', 'T2A', 'T3M', 'T3A', 'TLM', 'TLA', 'RO', 'RD', 'REB', 'AST', 'REC', 'PER', 'STP', 'FF', 'FS', 'VAL'].join(sep));

    const sorted = [...stats.playersList].sort((a, b) => Number(a.number) - Number(b.number));
    for (const p of sorted) {
      lines.push([
        p.number, p.name, p.pts,
        p.fg2m, p.fg2a, p.fg3m, p.fg3a, p.ftm, p.fta,
        p.oreb, p.dreb, p.reb, p.ast, p.stl, p.tov, p.blk, p.pf, p.pfd, p.val
      ].join(sep));
    }

    const t = stats.totals;
    lines.push([
      '', 'TOTALI', t.pts,
      t.fg2m, t.fg2a, t.fg3m, t.fg3a, t.ftm, t.fta,
      t.oreb, t.dreb, t.reb, t.ast, t.stl, t.tov, t.blk, t.pf, t.pfd, t.val
    ].join(sep));

    const csvContent = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tabellino_${match.homeName.replace(/\s+/g, '_')}_vs_${match.awayName.replace(/\s+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyWhatsAppSummary() {
    const match = getExportTargetMatch();
    if (!match) return;
    const stats = computeMatchStats(match);

    const qStr = stats.qHome.map((h, i) => `${quarterLabel(i + 1)}: ${h}-${stats.qAway[i]}`).join(' | ');
    const sorted = [...stats.playersList].sort((a, b) => b.pts - a.pts);

    const playerLines = sorted
      .map((p) => `#${p.number} ${p.name}: ${p.pts} pt, ${p.reb} reb, ${p.ast} ast (${p.pf} falli, val ${p.val})`)
      .join('\n');

    const text =
      `🏀 *${match.homeName} ${stats.homeScore} - ${stats.awayScore} ${match.awayName}*\n` +
      `📊 Parziali: ${qStr}\n\n` +
      `*Tabellino ${match.homeName}:*\n${playerLines}`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        const btn = $('btn-copy-whatsapp');
        const orig = btn.textContent;
        btn.textContent = '✓ Copiato!';
        setTimeout(() => { btn.textContent = orig; }, 1800);
      });
    } else {
      prompt('Copia il riepilogo:', text);
    }
  }

  function exportBoxScorePNG() {
    const match = getExportTargetMatch();
    if (!match) return;
    const stats = computeMatchStats(match);
    const sorted = [...stats.playersList].sort((a, b) => Number(a.number) - Number(b.number));

    const canvas = $('export-canvas');
    const width = 1120;
    const rowH = 38;
    const height = 270 + (sorted.length + 2) * rowH + 60;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, width, height);

    // Header banner
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(28, 24, width - 56, 150);
    ctx.fillStyle = match.homeColor || '#f97316';
    ctx.fillRect(28, 24, 10, 150);
    ctx.fillStyle = match.awayColor || '#38bdf8';
    ctx.fillRect(width - 38, 24, 10, 150);

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('TABELLINO PARTITA — BASKETSTATS IPAD', width / 2, 56);

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(`${match.homeName}   ${stats.homeScore}  -  ${stats.awayScore}   ${match.awayName}`, width / 2, 108);

    const qStr = stats.qHome.map((h, i) => `${quarterLabel(i + 1)}: ${h}-${stats.qAway[i]}`).join('   |   ');
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '600 18px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(qStr, width / 2, 148);

    // Table header
    const startY = 204;
    const cols = [
      { label: '#', x: 46, align: 'left' },
      { label: 'GIOCATORE', x: 96, align: 'left' },
      { label: 'PTS', x: 340, align: 'center' },
      { label: 'T2', x: 410, align: 'center' },
      { label: 'T3', x: 480, align: 'center' },
      { label: 'TL', x: 550, align: 'center' },
      { label: 'REB', x: 625, align: 'center' },
      { label: 'AST', x: 695, align: 'center' },
      { label: 'REC', x: 760, align: 'center' },
      { label: 'PER', x: 825, align: 'center' },
      { label: 'STP', x: 890, align: 'center' },
      { label: 'FF', x: 955, align: 'center' },
      { label: 'VAL', x: 1035, align: 'center' }
    ];

    ctx.fillStyle = '#111827';
    ctx.fillRect(28, startY, width - 56, rowH);
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, sans-serif';
    cols.forEach((c) => {
      ctx.textAlign = c.align;
      ctx.fillText(c.label, c.x, startY + 24);
    });

    // Rows
    sorted.forEach((p, idx) => {
      const y = startY + (idx + 1) * rowH;
      ctx.fillStyle = idx % 2 === 0 ? '#162033' : '#1e293b';
      ctx.fillRect(28, y, width - 56, rowH);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '600 16px -apple-system, BlinkMacSystemFont, sans-serif';

      const vals = [
        `#${p.number}`, p.name.slice(0, 18), String(p.pts),
        `${p.fg2m}/${p.fg2a}`, `${p.fg3m}/${p.fg3a}`, `${p.ftm}/${p.fta}`,
        String(p.reb), String(p.ast), String(p.stl), String(p.tov), String(p.blk), String(p.pf), String(p.val)
      ];
      cols.forEach((c, ci) => {
        ctx.textAlign = c.align;
        ctx.fillText(vals[ci], c.x, y + 24);
      });
    });

    // Totals
    const totY = startY + (sorted.length + 1) * rowH;
    const t = stats.totals;
    ctx.fillStyle = 'rgba(249, 115, 22, 0.25)';
    ctx.fillRect(28, totY, width - 56, rowH);
    ctx.fillStyle = '#fdba74';
    ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, sans-serif';
    const totVals = [
      '', 'TOTALI SQUADRA', String(t.pts),
      `${t.fg2m}/${t.fg2a}`, `${t.fg3m}/${t.fg3a}`, `${t.ftm}/${t.fta}`,
      String(t.reb), String(t.ast), String(t.stl), String(t.tov), String(t.blk), String(t.pf), String(t.val)
    ];
    cols.forEach((c, ci) => {
      ctx.textAlign = c.align;
      ctx.fillText(totVals[ci], c.x, totY + 24);
    });

    const link = document.createElement('a');
    link.download = `tabellino_${match.homeName.replace(/\s+/g, '_')}_vs_${match.awayName.replace(/\s+/g, '_')}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  // ==================== PLAY-BY-PLAY MODAL ====================
  function openPbpModal() {
    if (!activeMatch) return;
    const list = $('pbp-list');
    if (activeMatch.events.length === 0) {
      list.innerHTML = '<p class="empty-hint">Nessun evento registrato finora.</p>';
    } else {
      list.innerHTML = [...activeMatch.events]
        .reverse()
        .map(
          (ev) => `
        <div class="pbp-item">
          <div>${escapeHtml(formatEventDescription(ev, activeMatch))}</div>
          <button type="button" class="btn-icon-xs text-danger" data-del-event="${ev.id}" title="Elimina evento">✕</button>
        </div>`
        )
        .join('');
    }
    $('pbp-modal').classList.remove('hidden');
  }

  // ==================== EVENT LISTENERS ====================
  $('home-name').addEventListener('input', persistSavedTeam);
  $('home-color').addEventListener('change', persistSavedTeam);

  $('add-player-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const numEl = $('player-number');
    const nameEl = $('player-name');
    const num = numEl.value.trim();
    const name = nameEl.value.trim();
    if (!num || !name) return;

    const starterCount = savedTeam.roster.filter((p) => p.starter).length;
    savedTeam.roster.push({
      id: uid(),
      number: num,
      name,
      starter: starterCount < 5
    });
    persistSavedTeam();
    renderSetupRoster();
    numEl.value = '';
    nameEl.value = '';
    numEl.focus();
  });

  $('setup-roster-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    if (action === 'delete-player') {
      savedTeam.roster = savedTeam.roster.filter((p) => p.id !== id);
    } else if (action === 'toggle-starter') {
      const p = savedTeam.roster.find((x) => x.id === id);
      if (p) {
        if (!p.starter && savedTeam.roster.filter((x) => x.starter).length >= 5) {
          alert('Hai già 5 giocatori in quintetto! Deselezionane uno prima.');
          return;
        }
        p.starter = !p.starter;
      }
    }
    persistSavedTeam();
    renderSetupRoster();
  });

  $('btn-load-sample').addEventListener('click', () => {
    if (savedTeam.roster.length > 0 && !confirm('Sostituire la rosa attuale con una rosa di esempio?')) return;
    savedTeam.roster = [
      { id: uid(), number: '4', name: 'Rossi', starter: true },
      { id: uid(), number: '7', name: 'Bianchi', starter: true },
      { id: uid(), number: '10', name: 'Verdi', starter: true },
      { id: uid(), number: '14', name: 'Ferrari', starter: true },
      { id: uid(), number: '23', name: 'Esposito', starter: true },
      { id: uid(), number: '8', name: 'Romano', starter: false },
      { id: uid(), number: '11', name: 'Colombo', starter: false },
      { id: uid(), number: '15', name: 'Ricci', starter: false },
      { id: uid(), number: '32', name: 'Marino', starter: false }
    ];
    if (!$('home-name').value.trim()) $('home-name').value = 'Olimpia Basket';
    if (!$('away-name').value.trim()) $('away-name').value = 'Virtus Ospiti';
    persistSavedTeam();
    renderSetupRoster();
  });

  $('btn-clear-roster').addEventListener('click', () => {
    if (savedTeam.roster.length === 0) return;
    if (!confirm('Vuoi davvero svuotare tutta la rosa?')) return;
    savedTeam.roster = [];
    persistSavedTeam();
    renderSetupRoster();
  });

  $('btn-start-match').addEventListener('click', startNewMatch);
  $('btn-resume-match').addEventListener('click', () => {
    if (activeMatch) {
      selectedPlayerId = activeMatch.players.find((p) => p.onCourt)?.id || activeMatch.players[0]?.id || null;
      openMatchView();
    }
  });
  $('btn-discard-active').addEventListener('click', () => {
    if (!confirm('Scartare la partita in corso non ancora salvata?')) return;
    activeMatch = null;
    localStorage.removeItem(STORAGE_ACTIVE_KEY);
    updateResumeBanner();
  });

  $('history-list').addEventListener('click', (e) => {
    const openIdx = e.target.closest('[data-history-open]')?.dataset.historyOpen;
    if (openIdx !== undefined) {
      viewingHistoryMatch = matchHistory[Number(openIdx)];
      openBoxScoreModal(viewingHistoryMatch, false);
      return;
    }
    const delIdx = e.target.closest('[data-history-del]')?.dataset.historyDel;
    if (delIdx !== undefined) {
      if (!confirm('Eliminare questa partita dallo storico?')) return;
      matchHistory.splice(Number(delIdx), 1);
      saveJSON(STORAGE_HISTORY_KEY, matchHistory);
      renderHistoryList();
    }
  });

  // Match view interactions
  $('court-players-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-player-id]');
    if (card) handlePlayerTap(card.dataset.playerId);
  });

  $('bench-players-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-player-id]');
    if (card) handlePlayerTap(card.dataset.playerId);
  });

  document.querySelectorAll('.stat-btn[data-stat]').forEach((btn) => {
    btn.addEventListener('click', () => recordPlayerStat(btn.dataset.stat));
  });

  document.querySelectorAll('[data-opp-pts]').forEach((btn) => {
    btn.addEventListener('click', () => recordTeamEvent('OPP_PTS', Number(btn.dataset.oppPts)));
  });

  $('btn-away-foul').addEventListener('click', () => recordTeamEvent('OPP_FOUL', 1));
  $('btn-away-foul-minus').addEventListener('click', () => recordTeamEvent('OPP_FOUL', -1));
  $('btn-home-to').addEventListener('click', () => recordTeamEvent('HOME_TO', 1));
  $('btn-away-to').addEventListener('click', () => recordTeamEvent('AWAY_TO', 1));

  $('btn-undo').addEventListener('click', undoLastEvent);
  $('btn-clock-toggle').addEventListener('click', toggleClock);
  $('btn-prev-q').addEventListener('click', () => changeQuarter(-1));
  $('btn-next-q').addEventListener('click', () => changeQuarter(1));
  $('btn-reset-clock').addEventListener('click', resetQuarterClock);

  $('btn-sub-mode').addEventListener('click', () => {
    subMode = !subMode;
    subFirstPick = null;
    renderMatchView();
  });
  $('btn-cancel-sub').addEventListener('click', () => {
    subMode = false;
    subFirstPick = null;
    renderMatchView();
  });

  $('btn-back-setup').addEventListener('click', backToSetup);
  $('btn-open-boxscore').addEventListener('click', () => {
    viewingHistoryMatch = null;
    openBoxScoreModal(activeMatch, false);
  });
  $('btn-finish-match').addEventListener('click', () => {
    stopClock();
    viewingHistoryMatch = null;
    openBoxScoreModal(activeMatch, true);
  });

  $('btn-save-history').addEventListener('click', () => {
    if (!activeMatch) return;
    activeMatch.finished = true;
    matchHistory.unshift(activeMatch);
    saveJSON(STORAGE_HISTORY_KEY, matchHistory);
    activeMatch = null;
    localStorage.removeItem(STORAGE_ACTIVE_KEY);
    $('boxscore-modal').classList.add('hidden');
    backToSetup();
  });

  $('btn-close-boxscore').addEventListener('click', () => {
    viewingHistoryMatch = null;
    $('boxscore-modal').classList.add('hidden');
  });

  $('btn-export-png').addEventListener('click', exportBoxScorePNG);
  $('btn-copy-whatsapp').addEventListener('click', copyWhatsAppSummary);
  $('btn-export-csv').addEventListener('click', exportCSV);
  $('btn-print-pdf').addEventListener('click', () => window.print());

  // Play-by-Play modal
  $('btn-open-pbp').addEventListener('click', openPbpModal);
  $('btn-close-pbp').addEventListener('click', () => $('pbp-modal').classList.add('hidden'));
  $('pbp-list').addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-del-event]');
    if (!delBtn || !activeMatch) return;
    const evId = delBtn.dataset.delEvent;
    activeMatch.events = activeMatch.events.filter((ev) => ev.id !== evId);
    saveActiveMatch();
    renderMatchView();
    openPbpModal();
  });

  // Clock Edit modal
  $('btn-edit-clock').addEventListener('click', () => {
    if (!activeMatch) return;
    stopClock();
    $('edit-clock-min').value = Math.floor(activeMatch.clockSeconds / 60);
    $('edit-clock-sec').value = activeMatch.clockSeconds % 60;
    $('clock-modal').classList.remove('hidden');
  });
  $('btn-close-clock').addEventListener('click', () => $('clock-modal').classList.add('hidden'));
  $('btn-save-clock').addEventListener('click', () => {
    if (!activeMatch) return;
    const m = Math.max(0, Math.min(20, parseInt($('edit-clock-min').value, 10) || 0));
    const s = Math.max(0, Math.min(59, parseInt($('edit-clock-sec').value, 10) || 0));
    activeMatch.clockSeconds = m * 60 + s;
    saveActiveMatch();
    renderMatchView();
    $('clock-modal').classList.add('hidden');
  });

  // PWA Help modal
  $('btn-pwa-help').addEventListener('click', () => $('pwa-modal').classList.remove('hidden'));
  $('btn-close-pwa').addEventListener('click', () => $('pwa-modal').classList.add('hidden'));

  // Close modals on backdrop click
  document.querySelectorAll('.modal-backdrop').forEach((bd) => {
    bd.addEventListener('click', () => {
      viewingHistoryMatch = null;
      bd.closest('.modal').classList.add('hidden');
    });
  });

  // Init
  initSetupView();
})();
