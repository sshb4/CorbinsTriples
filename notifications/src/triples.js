export const PLAYER_ID = 682998;
export const TEAM_ID = 109;

export function tripleEvents(feed, startAt, now = Date.now()) {
  if (feed.gameData?.game?.type !== 'R') return [];
  const gameId = feed.gamePk;
  if (!Number.isInteger(gameId)) return [];
  const teams = feed.gameData?.teams;
  const opponent = teams?.away?.id === TEAM_ID ? teams.home : teams?.away;
  const name = String(opponent?.teamName || 'the opposition')
    .replace(/[^a-zA-Z0-9 .-]/g, '').slice(0, 24);
  return (feed.liveData?.plays?.allPlays || []).flatMap(play => {
    const when = Date.parse(play.about?.endTime);
    const index = play.about?.atBatIndex;
    if (play.matchup?.batter?.id !== PLAYER_ID ||
        play.result?.eventType !== 'triple' || !play.about?.isComplete ||
        !Number.isInteger(index) || !Number.isFinite(when) ||
        when <= startAt || when < now - 6 * 60 * 60 * 1000 || when > now) return [];
    const inning = Number(play.about.inning);
    const body = `Corbin Triples: HE HIT ONE. vs ${name}, inning ${inning}. corbinstriples.com Reply STOP to unsubscribe.`;
    return [{ id: `${gameId}:${index}`, occurredAt: when, body }];
  });
}
