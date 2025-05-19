import { DAY, MINUTE } from "./timeConstants";
import {
  MAXIMUM_PENALTY_DAYS,
  MINIMUM_DAYS_FOR_RANK,
  RANK_PER_DAY,
} from "./config";
import { beatmapSetFromAPI, mapEventFromAPI } from "./utils";
import {
  BeatmapSet,
  BeatmapSetAPI,
  MapEvent,
  MapEventAPI,
} from "./beatmap.types";

require("dotenv").config();

export const getAccessToken = async (): Promise<[string, number]> => {
  const body = {
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: "public",
  };

  const response = await fetch("https://osu.ppy.sh/oauth/token", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  if (!response.ok || !data) throw new Error("failed to get accessToken");

  return [data.access_token, Date.now() + (data.expires_in - 3600) * 1000];
};

async function getAPI<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = (await response.json()) as T;

  if (!response.ok || !data) throw new Error(`failed to fetch ${url}`);

  return data;
}

export const getBeatmapSet = async (
  accessToken: string,
  beatmapSetId: number,
) => {
  const data = await getAPI<BeatmapSetAPI>(
    `https://osu.ppy.sh/api/v2/beatmapsets/${beatmapSetId}`,
    accessToken,
  );

  const beatmapSet = beatmapSetFromAPI(data);
  if (data.status !== "ranked") {
    await setQueueDate(beatmapSet, accessToken);

    // very unlikely that a map has unresolved mods right after getting qualified
    // await setUnresolved(beatmapSet, accessToken);
  }

  return beatmapSet;
};

export const getQualifiedMaps = async (accessToken: string) => {
  const dataList: BeatmapSetAPI[] = [];
  let page = 1;
  while (true) {
    const data = await getAPI<{ beatmapsets: BeatmapSetAPI[] }>(
      `https://osu.ppy.sh/api/v2/beatmapsets/search?s=qualified&sort=ranked_asc&nsfw=true&page=${page}`,
      accessToken,
    );

    dataList.push(...data.beatmapsets);
    if (data.beatmapsets.length < 50) break;
    page++;
  }

  if (process.env.MAPS_COUNT) {
    dataList.splice(parseInt(process.env.MAPS_COUNT));
  }

  const qualifiedMaps: BeatmapSet[][] = [[], [], [], []];
  for (const item of dataList) {
    const beatmapSet = beatmapSetFromAPI(item);

    await setQueueDate(beatmapSet, accessToken);
    await setUnresolved(beatmapSet, accessToken);

    qualifiedMaps[beatmapSet.mode].push(beatmapSet);
  }

  return qualifiedMaps;
};

export const getRankedMaps = async (accessToken: string) => {
  const dataList: BeatmapSetAPI[] = [];
  let page = 1;
  while (true) {
    const data = await getAPI<{ beatmapsets: BeatmapSetAPI[] }>(
      `https://osu.ppy.sh/api/v2/beatmapsets/search?s=ranked&nsfw=true&q=ranked>${Math.floor(
        (Date.now() - (7 * DAY + 60 * MINUTE)) / 1000,
      )
      }&page=${page}`,
      accessToken,
    );

    dataList.push(...data.beatmapsets);
    if (data.beatmapsets.length < 50) break;
    page++;
  }

  const rankedMaps: BeatmapSet[][] = [[], [], [], []];
  dataList.reverse().forEach((beatmapSetData) => {
    const beatmapSet = beatmapSetFromAPI(beatmapSetData);
    rankedMaps[beatmapSet.mode].push(beatmapSet);
  });

  if (process.env.MAPS_COUNT) {
    rankedMaps.forEach((beatmapSets) => {
      beatmapSets.splice(
        0,
        beatmapSets.length -
        Math.max(RANK_PER_DAY, parseInt(process.env.MAPS_COUNT!)),
      );
    });
  }

  return rankedMaps;
};

export const getMapEvents = async (
  accessToken: string,
  beatmapSetId: number,
) => {
  const url =
    `https://osu.ppy.sh/api/v2/beatmapsets/events?types[]=qualify&types[]=disqualify&types[]=rank&types[]=nominate&types[]=nomination_reset&beatmapset_id=${beatmapSetId}&limit=50`;
  const data = await getAPI<{ events: MapEventAPI[] }>(url, accessToken);

  return data.events;
};

const getMapUnresolved = async (accessToken: string, beatmapSetId: number) => {
  const url =
    `https://osu.ppy.sh/api/v2/beatmapsets/discussions?beatmapset_id=${beatmapSetId}&message_types[]=suggestion&message_types[]=problem&only_unresolved=true`;
  const data = await getAPI<{ discussions: any[] }>(url, accessToken);
  return data.discussions.length > 0;
};

export const getMapsUnresolved = async (accessToken: string) => {
  const url =
    `https://osu.ppy.sh/api/v2/beatmapsets/discussions?beatmapset_status=qualified&message_types[]=suggestion&message_types[]=problem&only_unresolved=true&show_review_embeds=on&limit=50`;
  const data = await getAPI<{ beatmapsets: BeatmapSetAPI[] }>(url, accessToken);
  return data.beatmapsets;
};

export const getEventsAfter = async (
  accessToken: string,
  lastEventId: number,
  limit = 5,
): Promise<[MapEvent[], number]> => {
  let page = 1;
  let apiCalls = 0;
  const newEvents: MapEvent[] = [];
  const newEventIds: number[] = [];
  let newLastEventId: number;

  while (true) {
    const data = await getAPI<{ events: MapEventAPI[] }>(
      `https://osu.ppy.sh/api/v2/beatmapsets/events?types[]=qualify&types[]=rank&types[]=disqualify&limit=${limit}&page=${page}`,
      accessToken,
    );
    apiCalls++;
    newLastEventId ??= data.events[0].id;
    for (const event of data.events) {
      if (event.id == lastEventId) return [newEvents.reverse(), newLastEventId];

      // skip duplicates caused by timeout
      if (newEventIds.includes(event.id)) continue;

      newEvents.push(mapEventFromAPI(event));
      newEventIds.push(event.id);
    }
    if (apiCalls > 30) {
      await new Promise((resolve) => setTimeout(resolve, 60000));
      apiCalls = 0;
    }
    page++;
  }
};

export const getLatestEvent = async (accessToken: string) => {
  const data = await getAPI<{ events: MapEventAPI[] }>(
    "https://osu.ppy.sh/api/v2/beatmapsets/events?types[]=qualify&types[]=rank&types[]=disqualify&limit=5",
    accessToken,
  );
  return data.events[0].id;
};

let lastRequestDate = 0;

const setUnresolved = async (beatmapSet: BeatmapSet, accessToken: string) => {
  if (Date.now() - lastRequestDate < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  beatmapSet.unresolved = await getMapUnresolved(accessToken, beatmapSet.id);
  lastRequestDate = Date.now();
};

const setQueueDate = async (beatmapSet: BeatmapSet, accessToken: string) => {
  if (Date.now() - lastRequestDate < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log(
    new Date().toISOString(),
    `- calculating queueDate for ${beatmapSet.id} ${beatmapSet.artist} - ${beatmapSet.title}`,
  );

  type MapEvent = {
    type: MapEventAPI["type"];
    time: number;
    beatmapIds: number[];
    nominators: number[];
    userId: number;
  };

  const events: MapEvent[] = (await getMapEvents(accessToken, beatmapSet.id))
    .map((event) => ({
      type: event.type,
      time: Date.parse(event.created_at),
      beatmapIds: event.comment?.beatmap_ids ?? [],
      nominators: event.comment?.nominator_ids ?? [],
      userId: event.user_id,
    }))
    .reverse();
  lastRequestDate = Date.now();

  let previousQueueDuration = 0;
  let queuedAt: number | null = null;
  let lastDisqualifiedEvent: MapEvent | null = null;
  let nominators: number[] = [];

  let penaltyDays = 0;

  function sameIds(a: number[], b: number[]) {
    const setB = new Set(b);
    return a.length === b.length && a.every((item) => setB.has(item));
  }

  function diffsAdded(newMapIds: number[], oldMapIds: number[]) {
    const oldMapIdsSet = new Set(oldMapIds);
    return newMapIds.filter((beatmapId) => !oldMapIdsSet.has(beatmapId))
      .length > 0;
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    switch (event.type) {
      case "qualify":
        queuedAt = event.time;

        // reset previousQueueDuration from changes to beatmap ranking timer
        // don't need this anymore
        // const rankingSystemUpdate = (new Date("2024-09-13T12:00:00.000Z"))
        //   .getTime();
        // if (
        //   i !== events.length - 1 && lastDisqualifiedEvent != null &&
        //   event.time > rankingSystemUpdate &&
        //   lastDisqualifiedEvent.time < rankingSystemUpdate
        // ) {
        //   previousQueueDuration = 0;
        // }

        // https://github.com/ppy/osu-web/blob/476cd205258873f899b3d8c81b2dbe7010799751/app/Models/Beatmapset.php#L762-L764
        // haven't verified yet, but it appears that resets due to change in nominators are still affected by penaltyDays
        if (lastDisqualifiedEvent != null && !sameIds(lastDisqualifiedEvent.nominators, nominators)) {
          console.log(lastDisqualifiedEvent?.nominators);
          console.log(nominators);
          queuedAt = event.time;
        }

        // https://github.com/ppy/osu-web/blob/476cd205258873f899b3d8c81b2dbe7010799751/app/Models/Beatmapset.php#L633-L653
        if (
          lastDisqualifiedEvent != null && diffsAdded(
            beatmapSet.beatmaps.map((b) => b.id),
            lastDisqualifiedEvent.beatmapIds,
          )
        ) {
          console.log("reset");
          queuedAt = event.time;
        } else {
          const maxAdjustment = (MINIMUM_DAYS_FOR_RANK - 1) * DAY;
          const adjustment = Math.min(previousQueueDuration, maxAdjustment);
          queuedAt = event.time - adjustment;

          if (lastDisqualifiedEvent != null) {
            const interval = (event.time - lastDisqualifiedEvent.time) / DAY;
            penaltyDays = Math.min(
              Math.floor(interval / 7),
              MAXIMUM_PENALTY_DAYS,
            );
            queuedAt += penaltyDays * DAY;
            // console.log(new Date(queuedAt).toISOString());
          }
        }

        break;
      case "disqualify":
        lastDisqualifiedEvent = event;

        if (queuedAt != null) {
          previousQueueDuration = event.time - queuedAt;
        }

        nominators = [];
        break;
      case "rank":
        previousQueueDuration = 0;
        queuedAt = null;
        break;
      case "nominate":
        nominators.push(event.userId);
        break;
      case "nomination_reset":
        nominators = [];
        break;
      default:
        break;
    }
  }

  // all maps need to be qualified for at least 7 days
  beatmapSet.queueDate = new Date(
    queuedAt! + MINIMUM_DAYS_FOR_RANK * DAY,
  );

  // console.log(beatmapSet.queueDate.toISOString(), "- queueDate");

  console.log(new Date().toISOString(), "- success");
};
