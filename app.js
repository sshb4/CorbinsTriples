
      const MLB_BASE = "https://statsapi.mlb.com/api/v1";
      const PERSON_ID = 682998;
      const AUTO_REFRESH_MS = 5 * 60 * 1000;

      const els = {
        status: document.getElementById("status"),
        seasonTriples: document.getElementById("season-triples"),
        seasonLabel: document.getElementById("season-label"),
        careerTriples: document.getElementById("career-triples"),
        careerSeasonsMain: document.getElementById("career-seasons-main"),
        recentTriples: document.getElementById("recent-triples"),
        careerTable: document.getElementById("career-table"),
        seasonRankLabel: document.getElementById("season-rank-label"),
        seasonLeaderboard: document.getElementById("season-leaderboard"),
        careerLeaderboard: document.getElementById("career-leaderboard"),
        error: document.getElementById("error"),
        refreshButton: document.getElementById("refresh-button"),
      };

      const kineticNumber = document.getElementById("kinetic-number");
      const speedCanvas = document.getElementById("speed-canvas");
      const speedContext = speedCanvas.getContext("2d");
      const numberMain = document.getElementById("number-main");
      const numberHighlight = document.getElementById("number-highlight");
      const numberGhosts = [...kineticNumber.querySelectorAll(".number-ghost")];
      const numberScene = document.createElement("canvas");
      const numberSceneContext = numberScene.getContext("2d");

      // Kept as null guards for the legacy SVG drawing helpers below.
      const tripleSvg = null;
      const heroNumber = null;
      const clipNumber = null;
      const speedGroup = null;
      const insideSpeed = null;

      let refreshTimer = null;
      let statusTimer = null;
      let loading = false;
      let lastLoadedAt = null;

      function fmtNumber(value) {
        return Number.isFinite(value) ? new Intl.NumberFormat().format(value) : "--";
      }

      function parseNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
      }

      function trimText(value) {
        return typeof value === "string" ? value.trim() : "";
      }

      function isoDateFromMaybe(value) {
        if (!value) return null;
        const str = String(value);
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
        const d = new Date(str);
        return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
      }

      function formatDateLabel(value) {
        const iso = isoDateFromMaybe(value);
        if (!iso) return "Unknown date";
        const date = new Date(`${iso}T00:00:00`);
        return new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(date);
      }

      function isToday(value) {
        const iso = isoDateFromMaybe(value);
        if (!iso) return false;
        const today = new Date();
        const local = new Date(`${iso}T00:00:00`);
        return (
          local.getFullYear() === today.getFullYear() &&
          local.getMonth() === today.getMonth() &&
          local.getDate() === today.getDate()
        );
      }

      function timeAgoLabel(value) {
        const when = new Date(value);
        if (Number.isNaN(when.getTime())) return "--";
        const diff = Date.now() - when.getTime();
        const minutes = Math.max(0, Math.floor(diff / 60000));
        if (minutes < 1) return "just now";
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.round(hours / 24);
        return `${days}d ago`;
      }

      function playerName(profile) {
        return trimText(profile?.fullName) || "Corbin Carroll";
      }

      function currentTeamName(profile) {
        return (
          trimText(profile?.currentTeam?.name) ||
          trimText(profile?.currentTeam?.clubName) ||
          "Arizona Diamondbacks"
        );
      }

      async function fetchJson(url, timeoutMs = 15000) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            cache: "no-store",
          });
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }
          return await response.json();
        } finally {
          window.clearTimeout(timeout);
        }
      }

      async function fetchAllStats(url) {
        const firstPage = await fetchJson(url);
        const firstStats = Array.isArray(firstPage.stats) ? firstPage.stats[0] : null;
        const firstSplits = extractSplits(firstPage);
        const totalSplits = parseNumber(firstStats?.totalSplits);

        if (!totalSplits || firstSplits.length >= totalSplits) return firstPage;

        try {
          const pageSize = Math.max(firstSplits.length, 500);
          const pageCount = Math.ceil((totalSplits - firstSplits.length) / pageSize);
          const pageUrls = Array.from({ length: pageCount }, (_, pageIndex) => {
            const pageUrl = new URL(url);
            pageUrl.searchParams.set("offset", firstSplits.length + pageIndex * pageSize);
            pageUrl.searchParams.set("limit", pageSize);
            return pageUrl.toString();
          });
          const pages = await Promise.all(pageUrls.map((pageUrl) => fetchJson(pageUrl)));
          const allSplits = [
            ...firstSplits,
            ...pages.flatMap((page) => extractSplits(page)),
          ];

          return {
            ...firstPage,
            stats: firstPage.stats.map((stat, index) =>
              index === 0 ? { ...stat, splits: allSplits } : stat
            ),
          };
        } catch (error) {
          console.warn("Could not load all leaderboard pages; using first page", error);
          return firstPage;
        }
      }

      function statValue(statBlock, key) {
        return parseNumber(statBlock?.stat?.[key]);
      }

      function extractSplits(payload) {
        if (!payload) return [];
        const stats = Array.isArray(payload.stats)
          ? payload.stats
          : Array.isArray(payload.people?.[0]?.stats)
            ? payload.people[0].stats
            : [];
        for (const statEntry of stats) {
          const splits = statEntry?.splits;
          if (Array.isArray(splits) && splits.length) return splits;
        }
        return [];
      }

      function extractGamePk(split) {
        return (
          split?.gamePk ??
          split?.game?.gamePk ??
          split?.game?.pk ??
          split?.game?.id ??
          null
        );
      }

      function extractSplitDate(split) {
        return (
          isoDateFromMaybe(split?.date) ||
          isoDateFromMaybe(split?.game?.date) ||
          isoDateFromMaybe(split?.game?.officialDate) ||
          isoDateFromMaybe(split?.gameDate) ||
          isoDateFromMaybe(split?.stat?.date) ||
          null
        );
      }

      function extractTeamName(split) {
        return (
          trimText(split?.team?.name) ||
          trimText(split?.team?.clubName) ||
          trimText(split?.team?.abbreviation) ||
          ""
        );
      }

      function extractOpponentName(split) {
        return (
          trimText(split?.opponent?.name) ||
          trimText(split?.opponent?.clubName) ||
          trimText(split?.opponent?.abbreviation) ||
          ""
        );
      }

      const TEAM_LOGO_IDS = {
        "Arizona Diamondbacks": 109,
        "Atlanta Braves": 144,
        "Baltimore Orioles": 110,
        "Boston Red Sox": 111,
        "Chicago Cubs": 112,
        "Chicago White Sox": 145,
        "Cincinnati Reds": 113,
        "Cleveland Guardians": 114,
        "Colorado Rockies": 115,
        "Detroit Tigers": 116,
        "Houston Astros": 117,
        "Kansas City Royals": 118,
        "Los Angeles Angels": 108,
        "Los Angeles Dodgers": 119,
        "Miami Marlins": 146,
        "Milwaukee Brewers": 158,
        "Minnesota Twins": 142,
        "New York Mets": 121,
        "New York Yankees": 147,
        "Oakland Athletics": 133,
        "Philadelphia Phillies": 143,
        "Pittsburgh Pirates": 134,
        "San Diego Padres": 135,
        "San Francisco Giants": 137,
        "Seattle Mariners": 136,
        "St. Louis Cardinals": 138,
        "Tampa Bay Rays": 139,
        "Texas Rangers": 140,
        "Toronto Blue Jays": 141,
        "Washington Nationals": 120,
      };

      function teamLogoUrl(teamName) {
        const teamId = TEAM_LOGO_IDS[teamName];
        return teamId ? `https://www.mlbstatic.com/team-logos/${teamId}.svg` : "";
      }

      function extractPlayerId(split) {
        return split?.player?.id ?? split?.person?.id ?? split?.playerId ?? null;
      }

      function extractPlayerName(split) {
        return (
          trimText(split?.player?.fullName) ||
          trimText(split?.player?.fullNameDisplay) ||
          trimText(split?.person?.fullName) ||
          ""
        );
      }

      function getLeaderboardData(payload, playerId, fallbackName) {
        const rows = extractSplits(payload)
          .map((split) => ({
            triples: statValue(split, "triples"),
            playerId: extractPlayerId(split),
            playerName: extractPlayerName(split) || "Unknown",
          }))
          .filter((row) => row.playerId || row.playerName);

        rows.sort((a, b) => b.triples - a.triples);
        const scoreCounts = new Map();
        for (const row of rows) {
          scoreCounts.set(row.triples, (scoreCounts.get(row.triples) || 0) + 1);
        }

        // Use competition ranking: tied positions share a rank and the next
        // rank skips the number of players in the tie.
        let previousTriples = null;
        let previousRank = 0;
        const rankedRows = rows.map((row, index) => {
          const rank = row.triples === previousTriples ? previousRank : index + 1;
          previousTriples = row.triples;
          previousRank = rank;
          return {
            ...row,
            rank,
            tied: scoreCounts.get(row.triples) > 1,
          };
        });
        const index = rankedRows.findIndex(
          (row) =>
            String(row.playerId) === String(playerId) ||
            row.playerName === fallbackName
        );
        if (index < 0) return null;

        const current = rankedRows[index];
        const otherRows = rankedRows.filter((row) => row !== current);
        const nextTriples = current.triples + 1;
        const nextRank = 1 + otherRows.filter((row) => row.triples > nextTriples).length;
        const ahead = otherRows.filter((row) => row.triples > current.triples);

        return {
          rank: current.rank,
          nextRank,
          nextTied: otherRows.some((row) => row.triples === nextTriples),
          triplesToClimb: ahead.length
            ? Math.min(...ahead.map((row) => row.triples)) - current.triples
            : null,
          rows:
            index < 10
              ? rankedRows.slice(0, 10)
              : [
                  ...rankedRows.slice(0, 10),
                  { ellipsis: true },
                  { ...rankedRows[index], playerName: fallbackName },
                ],
        };
      }

      function renderLeaderboardProjection(element, data) {
        element.hidden = !data || data.rank === 1;
        element.replaceChildren();
        if (element.hidden) return;

        const heading = document.createElement("strong");
        heading.textContent = "Next triple";
        const gain = data.rank - data.nextRank;
        const rankLabel = `#${data.nextTied ? "T-" : ""}${fmtNumber(data.nextRank)}`;
        const description = gain > 0
          ? `↑ ${fmtNumber(gain)} ${gain === 1 ? "spot" : "spots"} to ${rankLabel}`
          : `Stays at ${rankLabel} · ${fmtNumber(data.triplesToClimb)} triples to climb`;
        element.append(heading, document.createTextNode(description));
      }

      async function addCareerSeasonCounts(data) {
        if (!data) return;

        await Promise.all(
          data.rows
            .filter((row) => !row.ellipsis && row.playerId)
            .map(async (row) => {
              try {
                const payload = await fetchJson(
                  `${MLB_BASE}/people/${row.playerId}/stats?stats=yearByYear&group=hitting`
                );
                row.seasons = groupCareerByYear(payload).length;
              } catch (error) {
                console.warn(`Could not load seasons for ${row.playerName}`, error);
                row.seasons = null;
              }
            })
        );
      }

      function renderLeaderboard(element, data, showSeasons, player) {
        if (!data) {
          element.innerHTML = `<li class="empty">No data.</li>`;
          return;
        }

        element.innerHTML = data.rows
          .map((row) => {
            if (row.ellipsis) return `<li class="ellipsis">...</li>`;
            const current =
              String(row.playerId) === String(PERSON_ID) ||
              row.playerName === player;
            const rankLabel = row.tied
              ? `T-${fmtNumber(row.rank)}`
              : `#${fmtNumber(row.rank)}`;
            return `
              <li class="${current ? "current" : ""}">
                <span>${rankLabel} ${row.playerName}</span>
                ${
                  showSeasons
                    ? `<span>${row.seasons == null ? "--" : `${row.seasons}`}</span><strong>${fmtNumber(row.triples)}</strong>`
                    : `<strong>${fmtNumber(row.triples)}</strong>`
                }
              </li>
            `;
          })
          .join("");
        const currentRow = element.querySelector(".current");
        if (currentRow && data.rank > 1) {
          const projection = document.createElement("p");
          projection.className = "leaderboard-projection";
          renderLeaderboardProjection(projection, data);
          currentRow.append(projection);
        }
      }

      function seasonTriplesFrom(payload, season) {
        const splits = extractSplits(payload);
        const seasonSplit = splits.find((split) => String(split?.season) === String(season));
        if (seasonSplit) return statValue(seasonSplit, "triples");
        if (splits.length === 1) return statValue(splits[0], "triples");
        return 0;
      }

      function careerTriplesFrom(payload) {
        const splits = extractSplits(payload);
        if (!splits.length) return 0;
        return splits.reduce((sum, split) => sum + statValue(split, "triples"), 0);
      }

      function groupCareerByYear(payload) {
        const splits = extractSplits(payload);
        const grouped = new Map();

        for (const split of splits) {
          const season = String(split?.season ?? split?.date?.slice?.(0, 4) ?? "");
          if (!season) continue;
          const entry = grouped.get(season) || { triples: 0, teams: new Set() };
          entry.triples += statValue(split, "triples");

          const team = extractTeamName(split);
          if (team) entry.teams.add(team);
          grouped.set(season, entry);
        }

        return [...grouped.entries()]
          .sort((a, b) => Number(b[0]) - Number(a[0]))
          .map(([season, entry]) => ({
            season,
            triples: entry.triples,
            teams: [...entry.teams],
          }));
      }

      function makeStroke(startX, startY, endX, endY, thickness, opacity, gradient) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const curve = (startY - endY) * 0.28;
        path.setAttribute(
          "d",
          `M ${startX} ${startY} C ${startX + (endX - startX) * 0.3} ${startY + curve} ${startX + (endX - startX) * 0.72} ${endY - curve} ${endX} ${endY}`
        );
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", gradient);
        path.setAttribute("stroke-width", thickness);
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("opacity", opacity);
        path.classList.add("motion-stroke");
        return path;
      }

      function drawGraphic() {
        if (!heroNumber || !clipNumber || !speedGroup || !insideSpeed) return;

        speedGroup.innerHTML = "";
        insideSpeed.innerHTML = "";

        const box = heroNumber.getBBox();
        const digits = heroNumber.textContent.length;
        const left = box.x;
        const right = box.x + box.width;
        const top = box.y;
        const height = box.height;
        const width = box.width;
        const expansion = digits === 1 ? 235 : digits === 2 ? 185 : digits === 3 ? 135 : 105;
        const strokes = [
          [.18, 1, 3.8, .52], [.25, .64, 1.7, .42], [.33, .88, 3, .58],
          [.41, .47, 1.25, .34], [.49, .76, 2.3, .49], [.57, .57, 1.5, .38],
          [.64, .91, 2.7, .52], [.72, .43, 1.15, .3], [.8, .7, 2, .4], [.87, .36, .95, .24],
        ];

        strokes.forEach(([position, lengthScale, thickness, opacity], index) => {
          const y = top + height * position;
          const length = expansion * lengthScale;
          const stagger = Math.sin(index * 2.31) * width * .018;
          const startX = left + width * (.08 + (index % 3) * .035) + stagger;
          const endX = right + length * (.62 + (index % 3) * .12);
          speedGroup.appendChild(makeStroke(
            startX,
            y,
            endX,
            y + Math.sin(index * 1.73) * 3,
            thickness,
            opacity,
            index > 5 ? "url(#red-speed-gradient)" : "url(#speed-gradient)"
          ));
        });

        for (let i = 0; i < 10; i++) {
          const progress = i / 9;
          const y = top + height * (0.28 + progress * 0.5);
          const startX = left + width * (0.16 + progress * 0.08);
          const length = expansion * (1.15 - progress * 0.2);
          speedGroup.appendChild(makeStroke(
            startX,
            y,
            right + length,
            y - 4 + Math.sin(i * 1.8) * 3,
            1.4 + (1 - progress) * 2.8,
            0.28 + (1 - progress) * 0.32,
            i % 3 === 0 ? "url(#speed-gradient)" : "url(#red-speed-gradient)"
          ));
        }

        [
          [.29, 1.45, 1.35, .34, -7],
          [.46, 1.22, 4.3, .34, 5],
          [.59, 1.38, 1.15, .27, -4],
          [.75, 1.15, 2.8, .3, 6],
        ].forEach(([position, lengthScale, thickness, opacity, bend]) => {
          const y = top + height * position;
          const length = expansion * lengthScale;
          const startX = left + width * .06;
          const endX = right + length * .82;
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute(
            "d",
            `M ${startX} ${y} C ${startX + length * .3} ${y + bend} ${startX + length * .72} ${y - bend} ${endX} ${y}`
          );
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", "url(#red-speed-gradient)");
          path.setAttribute("stroke-width", thickness);
          path.setAttribute("stroke-linecap", "round");
          path.setAttribute("opacity", opacity);
          path.classList.add("motion-stroke");
          speedGroup.appendChild(path);
        });

        for (let i = 0; i < 17; i++) {
          const y = top + height * (.12 + (i / 16) * .78);
          const length = expansion * (.055 + ((i * 17) % 9) / 100);
          const startX = left + width * .18 + ((i * 29) % 35);
          speedGroup.appendChild(makeStroke(
            startX,
            y,
            startX + length,
            y + ((i % 3) - 1) * 2,
            .55 + (i % 3) * .28,
            .12 + (i % 4) * .035,
            i % 4 === 0 ? "url(#red-speed-gradient)" : "url(#speed-gradient)"
          ));
        }

        for (let i = 0; i < 8; i++) {
          const y = top + height * (.24 + i * .075);
          insideSpeed.appendChild(makeStroke(
            left - width * .22,
            y,
            right + width * .12,
            y - 1,
            1 + (i % 3) * .55,
            .14 + (i % 3) * .035,
            i > 4 ? "url(#red-speed-gradient)" : "url(#speed-gradient)"
          ));
        }

        for (let i = 0; i < 5; i++) {
          const y = top + height * (.27 + i * .13);
          const length = width * (.055 + i * .018);
          speedGroup.appendChild(makeStroke(
            right - width * .025,
            y,
            right + length,
            y + (i % 2 ? 2 : -2),
            .8 + i * .25,
            .14,
            "url(#red-speed-gradient)"
          ));
        }

        tripleSvg.setAttribute("aria-label", `${heroNumber.textContent} triples in 2026`);
      }

      function setTripleNumber(value) {
        const cleanNumber = String(value).replace(/[^\d]/g, "") || "0";
        const target = Number(cleanNumber);
        const start = Number(numberMain.textContent) || 0;
        const startedAt = performance.now();
        const duration = 650;

        function animateNumber(now) {
          const progress = Math.min(1, (now - startedAt) / duration);
          const eased = 1 - Math.pow(1 - progress, 3);
          const current = Math.round(start + (target - start) * eased);
          numberMain.textContent = String(current);
          numberHighlight.textContent = String(current);
          numberGhosts.forEach((ghost) => { ghost.textContent = String(current); });
          kineticNumber.setAttribute("aria-label", `${current} triples in 2026`);
          renderNumberScene();
          animateSpeedCanvas();
          if (progress < 1) requestAnimationFrame(animateNumber);
        }

        requestAnimationFrame(animateNumber);
      }

      window.setTripleNumber = setTripleNumber;

      let canvasWidth = 0;
      let canvasHeight = 0;
      let speedParticles = [];
      let numberFrameReady = false;

      function resizeSpeedCanvas() {
        const rect = kineticNumber.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        speedCanvas.width = rect.width * ratio;
        speedCanvas.height = rect.height * ratio;
        speedCanvas.style.width = `${rect.width}px`;
        speedCanvas.style.height = `${rect.height}px`;
        speedContext.setTransform(ratio, 0, 0, ratio, 0, 0);
        canvasWidth = rect.width;
        canvasHeight = rect.height;
      }

      function createSpeedParticle(initial = false) {
        return {
          x: canvasWidth + Math.random() * canvasWidth * .35,
          y: canvasHeight * (.25 + Math.random() * .5),
          length: Math.random() * Math.random() * 150 + 15,
          speed: Math.random() * 8 + 2.5,
          thickness: Math.random() * 1.7 + .25,
          opacity: Math.random() * .55 + .1,
          life: initial ? Math.random() : 0,
        };
      }

      function initializeSpeedParticles() {
        speedParticles = Array.from(
          { length: Math.min(150, Math.floor(canvasWidth / 8)) },
          () => createSpeedParticle(true)
        );
      }

      function renderNumberScene() {
        if (!canvasWidth || !canvasHeight) return;
        const text = numberMain.textContent || "0";
        const ratio = window.devicePixelRatio || 1;
        numberScene.width = Math.max(1, Math.floor(canvasWidth * ratio));
        numberScene.height = Math.max(1, Math.floor(canvasHeight * ratio));
        numberSceneContext.setTransform(ratio, 0, 0, ratio, 0, 0);
        numberSceneContext.clearRect(0, 0, canvasWidth, canvasHeight);

        const mask = document.createElement("canvas");
        mask.width = numberScene.width;
        mask.height = numberScene.height;
        const maskContext = mask.getContext("2d");
        maskContext.setTransform(ratio, 0, 0, ratio, 0, 0);
        const fontSize = Math.min(canvasHeight, canvasWidth / (text.length * .62));
        const centerX = canvasWidth * .5;
        const centerY = canvasHeight * .62;
        maskContext.save();
        maskContext.translate(centerX, centerY);
        maskContext.transform(1, 0, -.08, 1, 0, 0);
        maskContext.font = `${fontSize}px "Bebas Neue", Impact, "Arial Black", Arial, sans-serif`;
        maskContext.textAlign = "center";
        maskContext.textBaseline = "middle";
        maskContext.lineJoin = "round";
        maskContext.lineWidth = fontSize * .045;
        maskContext.strokeStyle = "#000";
        maskContext.fillStyle = "#000";
        maskContext.strokeText(text, 0, 0);
        maskContext.fillText(text, 0, 0);
        maskContext.restore();

        const minY = centerY - fontSize * .45;
        const maxY = centerY + fontSize * .45;

        const fill = numberSceneContext.createLinearGradient(0, minY, 0, maxY || numberScene.height);
        fill.addColorStop(0, "#050505");
        fill.addColorStop(.45, "#090909");
        fill.addColorStop(.72, "#5b0d20");
        fill.addColorStop(1, "#c52243");
        numberSceneContext.save();
        numberSceneContext.drawImage(mask, 0, 0, canvasWidth, canvasHeight);
        numberSceneContext.globalCompositeOperation = "source-in";
        numberSceneContext.fillStyle = fill;
        numberSceneContext.fillRect(0, 0, canvasWidth, canvasHeight);
        numberSceneContext.restore();
        numberFrameReady = true;

      }

      function animateSpeedCanvas() {
        if (!canvasWidth || !canvasHeight || !numberScene.width || !numberScene.height || !numberFrameReady) return;
        speedContext.clearRect(0, 0, canvasWidth, canvasHeight);
        speedContext.drawImage(numberScene, 0, 0, canvasWidth, canvasHeight);
      }

      resizeSpeedCanvas();
      initializeSpeedParticles();
      renderNumberScene();
      animateSpeedCanvas();
      if (document.fonts?.ready) {
        document.fonts.ready.then(() => {
          renderNumberScene();
          animateSpeedCanvas();
        });
      }
      setTripleNumber(0);
      window.addEventListener("resize", () => {
        resizeSpeedCanvas();
        initializeSpeedParticles();
        renderNumberScene();
        animateSpeedCanvas();
      });
      window.addEventListener("load", () => {
        resizeSpeedCanvas();
        initializeSpeedParticles();
        renderNumberScene();
        animateSpeedCanvas();
      });
      if (window.ResizeObserver) {
        new ResizeObserver(() => {
          resizeSpeedCanvas();
          renderNumberScene();
          animateSpeedCanvas();
        }).observe(kineticNumber);
      }

      function clearError() {
        els.error.hidden = true;
        els.error.textContent = "";
      }

      function showError(message) {
        els.error.textContent = message;
        els.error.hidden = false;
      }

      function renderRecentTriples(events, player, teamName, season) {
        if (!events.length) {
          els.recentTriples.innerHTML = `
            <li class="empty">No triples yet.</li>
          `;
          return;
        }

        els.recentTriples.innerHTML = events
          .slice(0, 5)
          .map((event) => {
            const dayLabel = formatDateLabel(event.date);
            const venue = event.venue || "";
            const opponent = event.opponent || "Unknown";
            const locationBit = event.homeAway === "home" ? `vs. ${opponent}` : `@ ${opponent}`;
            const logoUrl = teamLogoUrl(opponent);
            return `
              <li class="triple-item${isToday(event.date) ? " today" : ""}">
                <div class="triple-event-row">
                  ${logoUrl ? `<img class="opponent-logo" src="${logoUrl}" alt="${opponent} logo" loading="lazy" />` : `<span></span>`}
                  <div class="triple-event-team">${locationBit}</div>
                  <div class="triple-event-day">${dayLabel}</div>
                </div>
              </li>
            `;
          })
          .join("");

      }

      async function markLeagueLeadingSeasons(rows) {
        await Promise.all(rows.map(async (row) => {
          try {
            const baseUrl = `${MLB_BASE}/stats?stats=season&group=hitting&season=${row.season}` +
              "&playerPool=ALL&sortStat=triples&order=desc&limit=1";
            const [leaguePayload, mlbPayload] = await Promise.all([
              fetchJson(`${baseUrl}&leagueIds=104`),
              fetchJson(baseUrl),
            ]);
            const leagueLeader = extractSplits(leaguePayload)[0];
            const mlbLeader = extractSplits(mlbPayload)[0];
            row.leagueLeader = Boolean(
              leagueLeader && row.triples >= statValue(leagueLeader, "triples")
            );
            row.mlbLeader = Boolean(
              mlbLeader && row.triples >= statValue(mlbLeader, "triples")
            );
          } catch (error) {
            console.warn(`Could not check the ${row.season} triples leader`, error);
            row.leagueLeader = false;
            row.mlbLeader = false;
          }
        }));
      }

      function renderCareerTable(rows) {
        if (!rows.length) {
          els.careerTable.innerHTML = `
            <tr>
              <td colspan="3" class="empty">No data.</td>
            </tr>
          `;
          return;
        }

        els.careerTable.innerHTML = rows
          .map((row) => {
            const teamText = row.teams.length ? row.teams.join(", ") : "Unknown team";
            return `
              <tr>
                <td class="year">${row.season}</td>
                <td class="team-list">${teamText}</td>
                <td class="leader-cell">
                  <strong class="${[
                    row.leagueLeader || row.mlbLeader ? "league-leading" : "",
                    row.mlbLeader ? "mlb-leading" : "",
                  ].filter(Boolean).join(" ")}">${fmtNumber(row.triples)}</strong>${
                    row.leagueLeader || row.mlbLeader
                      ? `<span class="leader-notes" aria-label="${row.mlbLeader ? "MLB leader" : "NL leader"}"><span>Led ${row.mlbLeader ? "MLB" : "NL"}</span></span>`
                      : ""
                  }
                </td>
              </tr>
            `;
          })
          .join("");
      }

      function fallbackTripleEvents(split, date, player) {
        const count = Math.max(1, statValue(split, "triples"));
        const gameTime = split?.game?.gameDate || split?.game?.date || null;
        const opponent = extractOpponentName(split);
        const homeAway = split?.isHome === true ? "home" : "away";

        return Array.from({ length: count }, (_, index) => ({
          date,
          gameTime,
          venue: "",
          opponent,
          homeAway,
          inning: "",
          half: "",
          description: `${player} tripled.`,
          playIndex: index,
        }));
      }

      async function loadRecentTripleEvents(season, playerId, player) {
        const gameLogUrl =
          `${MLB_BASE}/people/${playerId}/stats?stats=gameLog&group=hitting` +
          `&gameType=R&season=${season}`;
        const gameLogPayload = await fetchJson(gameLogUrl);
        let splits = extractSplits(gameLogPayload);

        if (!splits.length) {
          const hydratedUrl =
            `${MLB_BASE}/people/${playerId}?hydrate=` +
            `stats(type=gameLog,season=${season},group=hitting)`;
          const hydratedPayload = await fetchJson(hydratedUrl);
          splits = extractSplits(hydratedPayload);
        }

        const tripleGames = splits
          .map((split, index) => {
            const triples = statValue(split, "triples");
            const gamePk = extractGamePk(split);
            const date = extractSplitDate(split);
            return {
              split,
              index,
              triples,
              gamePk,
              date,
            };
          })
          .filter((entry) => entry.triples > 0 && entry.date)
          .sort((a, b) => new Date(b.date) - new Date(a.date));

        if (!tripleGames.length) return [];

        return tripleGames
          .flatMap(({ split, date }) => fallbackTripleEvents(split, date, player))
          .sort((a, b) => {
            const dateDiff = new Date(b.date) - new Date(a.date);
            if (dateDiff !== 0) return dateDiff;
            return (b.playIndex || 0) - (a.playIndex || 0);
          })
          .slice(0, 5);
      }

      async function loadData(canRetry = true) {
        if (loading) return;
        loading = true;
        clearError();
        els.status.textContent = "Loading...";
        els.refreshButton.disabled = true;

        try {
          const season = new Date().getFullYear();
          els.seasonLabel.textContent = `TRIPLES IN ${season}`;

          const profileUrl = `${MLB_BASE}/people/${PERSON_ID}`;
          const seasonUrl = `${MLB_BASE}/people/${PERSON_ID}/stats?stats=season&group=hitting&season=${season}`;
          const careerUrl = `${MLB_BASE}/people/${PERSON_ID}/stats?stats=career&group=hitting`;
          const yearByYearUrl = `${MLB_BASE}/people/${PERSON_ID}/stats?stats=yearByYear&group=hitting`;
          const seasonLeaderboardUrl =
            `${MLB_BASE}/stats?stats=season&group=hitting&season=${season}` +
            "&playerPool=ALL&sortStat=triples&order=desc&limit=5000";
          const careerLeaderboardUrl =
            `${MLB_BASE}/stats?stats=career&group=hitting` +
            "&playerPool=ALL&sortStat=triples&order=desc&limit=5000";

          const [profileRes, seasonRes, careerRes, yearRes, seasonLeaderboardRes, careerLeaderboardRes] = await Promise.allSettled([
            fetchJson(profileUrl),
            fetchJson(seasonUrl),
            fetchJson(careerUrl),
            fetchJson(yearByYearUrl),
            fetchAllStats(seasonLeaderboardUrl),
            fetchAllStats(careerLeaderboardUrl),
          ]);

          const profile = profileRes.status === "fulfilled" ? profileRes.value?.people?.[0] : null;
          const player = playerName(profile);
          const teamName = currentTeamName(profile);

          els.seasonRankLabel.textContent = season;
          const seasonLeaderboardData =
            seasonLeaderboardRes.status === "fulfilled"
              ? getLeaderboardData(seasonLeaderboardRes.value, PERSON_ID, player)
              : null;
          const careerLeaderboardData =
            careerLeaderboardRes.status === "fulfilled"
              ? getLeaderboardData(careerLeaderboardRes.value, PERSON_ID, player)
              : null;
          await addCareerSeasonCounts(careerLeaderboardData);
          renderLeaderboard(
            els.seasonLeaderboard,
            seasonLeaderboardData,
            false,
            player
          );
          renderLeaderboard(
            els.careerLeaderboard,
            careerLeaderboardData,
            true,
            player
          );

          const seasonTriples =
            seasonRes.status === "fulfilled"
              ? seasonTriplesFrom(seasonRes.value, season)
              : 0;
          const careerTriples =
            careerRes.status === "fulfilled"
              ? careerTriplesFrom(careerRes.value)
              : 0;
          const careerRows =
            yearRes.status === "fulfilled" ? groupCareerByYear(yearRes.value) : [];

          const seasonFallback = careerRows.find((row) => String(row.season) === String(season));
          const summedCareer = careerRows.reduce((sum, row) => sum + row.triples, 0);
          els.careerSeasonsMain.textContent = `${careerRows.length} seasons`;

          const heroTriples = seasonTriples || (seasonFallback ? seasonFallback.triples : 0);
          els.seasonTriples.textContent = fmtNumber(heroTriples);
          els.careerTriples.textContent = fmtNumber(careerTriples || summedCareer);
          setTripleNumber(heroTriples);

          let recentEvents = [];
          try {
            recentEvents = await loadRecentTripleEvents(season, PERSON_ID, player);
            renderRecentTriples(recentEvents, player, teamName, season);
          } catch (recentError) {
            console.error(recentError);
            els.recentTriples.innerHTML = `
              <li class="empty">No data.</li>
            `;
          }
          await markLeagueLeadingSeasons(careerRows);
          renderCareerTable(careerRows);

          lastLoadedAt = new Date();
          els.status.textContent = `Updated ${timeAgoLabel(lastLoadedAt)}`;

        } catch (error) {
          console.error(error);
          showError(
            "MLB API unavailable."
          );
          els.status.textContent = "Load failed";
          if (canRetry) {
            window.setTimeout(() => loadData(false), 1500);
          }
          els.seasonTriples.textContent = "--";
          els.careerTriples.textContent = "--";
          els.seasonLeaderboard.innerHTML = `<li class="empty">No data.</li>`;
          els.careerLeaderboard.innerHTML = `<li class="empty">No data.</li>`;
          els.careerSeasonsMain.textContent = "-- seasons";
          els.recentTriples.innerHTML = `
            <li class="empty">No data.</li>
          `;
          els.careerTable.innerHTML = `
            <tr>
              <td colspan="3" class="empty">No data.</td>
            </tr>
          `;
        } finally {
          els.refreshButton.disabled = false;
          loading = false;
        }
      }

      function scheduleAutoRefresh() {
        if (refreshTimer) window.clearInterval(refreshTimer);
        refreshTimer = window.setInterval(() => {
          loadData();
        }, AUTO_REFRESH_MS);

        if (statusTimer) window.clearInterval(statusTimer);
        statusTimer = window.setInterval(() => {
          if (lastLoadedAt && !loading) {
            els.status.textContent = `Updated ${timeAgoLabel(lastLoadedAt)}`;
          }
        }, 1000);
      }

      document.getElementById("refresh-button").addEventListener("click", () => {
        loadData();
      });

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && lastLoadedAt) {
          const minutesSince = (Date.now() - lastLoadedAt.getTime()) / 60000;
          if (minutesSince >= 4) {
            loadData();
          }
        }
      });

      scheduleAutoRefresh();
      loadData();
    