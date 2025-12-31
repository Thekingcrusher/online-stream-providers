/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
  baseUrl = "{{domain}}"

  getSettings(): Settings {
      return {
          episodeServers: ["HD-1", "HD-2", "HD-3"],
          supportsDub: true
      }
  }

  async search(query: SearchOptions): Promise<SearchResult[]> {
    // --- normalize helpers ---
    const normalize = (title) => {
      return (title || "")
        .toLowerCase()
        .replace(/(season|cour|part|the animation|the movie|movie)/g, "") // strip keywords
        .replace(/\d+(st|nd|rd|th)/g, (m) => m.replace(/st|nd|rd|th/, "")) // remove ordinal suffixes
        .replace(/[^a-z0-9]+/g, "") // remove non-alphanumeric
        .replace(/(?<!i)ii(?!i)/g, "2") // replace II with 2
    };

    const normalizeTitle = (title) => {
      return (title || "")
        .toLowerCase()
        .replace(/(season|cour|part|uncensored)/g, "") // strip keywords
        .replace(/\d+(st|nd|rd|th)/g, (m) => m.replace(/st|nd|rd|th/, "")) // remove ordinal suffixes
        .replace(/[^a-z0-9]+/g, ""); // remove non-alphanumeric
    };

    const decodeHtmlEntities = (str) => {
      return (str || "")
        .replace(/\\u0026/g, "&")     // convert \u0026 to &
        .replace(/&#(\d+);?/g, (m, dec) => String.fromCharCode(dec))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
    }

    const levenshteinSimilarity = (a, b) => {
      const lenA = a.length;
      const lenB = b.length;
      const dp = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1).fill(0));
    
      for (let i = 0; i <= lenA; i++) dp[i][0] = i;
      for (let j = 0; j <= lenB; j++) dp[0][j] = j;
    
      for (let i = 1; i <= lenA; i++) {
        for (let j = 1; j <= lenB; j++) {
          if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
          else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    
      const distance = dp[lenA][lenB];
      const maxLen = Math.max(lenA, lenB);
      return 1 - distance / maxLen; // similarity in range [0,1]
    };

    const start = query.media.startDate;
    const targetNormJP = normalize(query.media.romajiTitle);
    const targetNorm = query.media.englishTitle ? normalize(query.media.englishTitle) : targetNormJP;
  
    const fetchMatches = async (url: string) => {
      const reply = await fetch(url).then(r => r.json());
      const html  = reply.html;
    
      // Match <a href="/something-id" class="nav-item"> but exclude bottom links
      const regex = /<a href="\/([^"]+)" class="nav-item">[\s\S]*?<h3 class="film-name"[^>]*data-jname="([^"]+)"[^>]*>([^<]+)<\/h3>[\s\S]*?<div class="film-infor">\s*<span>([^<]+)<\/span>\s*<i[^>]*><\/i>\s*([^<]+)\s*<i[^>]*><\/i>/g;

      const monthMap: Record<string, number> = {
        Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
        Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
      };
    
      const matches = [...html.matchAll(regex)]
        .map(m => {
          const pageUrl = m[1]; // e.g., my-star-18330
          if (pageUrl.startsWith("search?")) return null; // exclude "View all results"
    
          const jname = m[2]?.trim();
          const title = m[3]?.trim();
          const dateStr = m[4].trim(); // e.g. "Jul 4, 2025"
          const format = m[5].trim().toUpperCase();

          let startDate = { year: 0, month: 0, day: 0 };
          const dateMatch = dateStr.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
          if (dateMatch) {
            const month = monthMap[dateMatch[1]];
            const day = parseInt(dateMatch[2]);
            const year = parseInt(dateMatch[3]);
            startDate = { year, month, day };
          }
    
          // Extract numeric ID if it exists (e.g., my-star-18330 → 18330)
          const idMatch = pageUrl.match(/-(\d+)$/);
          const id = idMatch ? idMatch[1] : pageUrl;
    
          return {
            id,
            pageUrl,
            title: decodeHtmlEntities(title),
            normTitleJP: normalize(decodeHtmlEntities(jname)),
            normTitle: normalize(decodeHtmlEntities(title)),
            startDate,
            format,
          };
        })
        .filter(Boolean); // remove null entries
    
      return matches;
    };

    // Base search
    const url = `${this.baseUrl}/ajax/search/suggest?keyword=${encodeURIComponent(query.query)}`;
    console.log(url)

    const matches = await fetchMatches(url);
  
    if (matches.length === 0) return [];

    // Filter results prioritizing from -> match title & start year/month -> match title & start year
    const exactTitle = (m) =>
      m.normTitle === targetNorm ||
      m.normTitleJP === targetNormJP;
    
    const looseTitle = (m) =>
      levenshteinSimilarity(m.normTitle, targetNorm) > 0.8 ||
      levenshteinSimilarity(m.normTitleJP, targetNormJP) > 0.8;

    const looserTitle = (m) =>
      m.normTitle.includes(targetNorm) ||
      m.normTitleJP.includes(targetNormJP) ||
      targetNorm.includes(m.normTitle) ||
      targetNormJP.includes(m.normTitleJP) ||
      levenshteinSimilarity(m.normTitle, targetNorm) > 0.6 ||
      levenshteinSimilarity(m.normTitleJP, targetNormJP) > 0.6;
    
    const dateYM = (m) =>
      m.startDate?.year === start?.year &&
      m.startDate?.month === start?.month;
    
    const dateY = (m) =>
      m.startDate?.year === start?.year;

    const exactFormat = (m) =>
      m.format === query.media.format.toUpperCase();

    const matchTiers = [
      (m) => exactTitle(m) && dateYM(m) && exactFormat(m),
      (m) => exactTitle(m) && dateY(m) && exactFormat(m),
      (m) => looseTitle(m) && dateYM(m) && exactFormat(m),
      (m) => looseTitle(m) && dateY(m) && exactFormat(m),
    ];
    
    let filtered: any[] = [];
    
    for (let page = 1; page <= 7; page++) {
      const pageUrl =
        page === 1
          ? url
          : `${url}&page=${page}`;
    
      const pageMatches = await fetchMatches(pageUrl);
    
      if (!pageMatches.length) break;

      const hasLoose = pageMatches.some(looserTitle);
      if (!hasLoose) break;
    
      for (const tier of matchTiers) {
        filtered = pageMatches.filter(tier);
        if (filtered.length) break;
      }
    
      if (filtered.length) break;
    }
  
    // Return results
    let results = filtered.map(m => ({
      id: `${m.id}/${query.dub ? "dub" : "sub"}`,
      title: m.title,
      url: `${this.baseUrl}/${m.pageUrl}`,
      subOrDub: query.dub ? "dub" : "sub",
    }));

    if (!query.media.startDate || !query.media.startDate.year) {
      const fetchMatches = async (url: string) => {
        const html = await fetch(url).then(res => res.text());
        // Match the main link
        const regex = /<a href="\/watch\/([^"]+)"[^>]+title="([^"]+)"[^>]+data-id="(\d+)"/g;
        return [...html.matchAll(regex)].map(m => {
          const id = m[3];
          const pageUrl = m[1];
          const title = m[2];
          // Find corresponding data-jname
          const jnameRegex = new RegExp(
            `<h3 class="film-name">[\\s\\S]*?<a[^>]+href="\\/${pageUrl}[^"]*"[^>]+data-jname="([^"]+)"`,
            "i"
          );
          const jnameMatch = html.match(jnameRegex);
          const jname = jnameMatch ? jnameMatch[1] : null;
          return {
            id,
            pageUrl,
            title: decodeHtmlEntities(title),
            normTitleJP: normalizeTitle(decodeHtmlEntities(jname)),
            normTitle: normalizeTitle(decodeHtmlEntities(title)),
          };
        });
      };
    
      // Base search
      const url = `${this.baseUrl}/search?keyword=${encodeURIComponent(query.query)}`;
      const matches = await fetchMatches(url);
      
      filtered = matches.filter(m => {
        const titleMatch =
          m.normTitle === normalizeTitle(query.query) ||
          m.normTitleJP === normalizeTitle(query.query) ||
          m.normTitle.includes(normalizeTitle(query.query)) ||
          m.normTitleJP.includes(normalizeTitle(query.query)) ||
          normalizeTitle(query.query).includes(m.normTitle) ||
          normalizeTitle(query.query).includes(m.normTitleJP);
        return titleMatch;
      });
      filtered.sort((a, b) => {
        const A = normalizeTitle(a.title);
        const B = normalizeTitle(b.title);
      
        // 1) Sort by length
        if (A.length !== B.length) {
          return A.length - B.length;
        }
      
        // 2) If lengths match, sort alphabetically
        return A.localeCompare(B);
      });
      results = filtered.map(m => ({
        id: `${m.id}/${query.dub ? "dub" : "sub"}`,
        title: m.title,
        url: `${this.baseUrl}/${m.pageUrl}`,
        subOrDub: query.dub ? "dub" : "sub",
      }));
    }

    return results;
  }

  async findEpisodes(animeId: string): Promise<EpisodeDetails[]> {
    const [id, subOrDub] = animeId.split("/");
    const res = await fetch(`${this.baseUrl}/ajax/v2/episode/list/${id}`, {
      headers: { "X-Requested-With": "XMLHttpRequest" }
    });
    const json = await res.json();
    const html = json.html;

    const episodes = [];
    const regex = /<a[^>]*class="[^"]*\bep-item\b[^"]*"[^>]*data-number="(\d+)"[^>]*data-id="(\d+)"[^>]*href="([^"]+)"[\s\S]*?<div class="ep-name[^"]*"[^>]*title="([^"]+)"/g;

    let match;
    while ((match = regex.exec(html)) !== null) {
      episodes.push({
        id: `${match[2]}/${subOrDub}`, // episode's internal ID
        number: parseInt(match[1], 10),
        url: this.baseUrl+match[3],
        title: match[4],
      });
    }

    return episodes;
  }

  async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
    const [id, subOrDub] = episode.id.split("/");
    const allowedTypes =
      subOrDub === "sub" ? ["sub", "raw"] : [subOrDub];
    const typePattern = allowedTypes.join("|");
    let serverName = _server !== "default" ? _server : "HD-1";
    
    // Fetch server list
    const serverJson = await fetch(`${this.baseUrl}/ajax/v2/episode/servers?episodeId=${id}`, {
        headers: { "X-Requested-With": "XMLHttpRequest" }
    }).then(res => res.json());
    
    const serverHtml = serverJson.html;

    // Regex to match the right block (sub or dub) and find the server by name
    const regex = new RegExp(
        `<div[^>]*class="item server-item"[^>]*data-type="${typePattern}"[^>]*data-id="(\\d+)"[^>]*>\\s*<a[^>]*>\\s*${serverName}\\s*</a>`,
        "i"
    );

    const match = regex.exec(serverHtml);
    if (!match) throw new Error(`Server "${serverName}" (${allowedTypes.join("/")}) not found`);

    const serverId = match[1];

    // Fetch source embed
    const sourcesJson = await fetch(`${this.baseUrl}/ajax/v2/episode/sources?id=${serverId}`, {
        headers: { "X-Requested-With": "XMLHttpRequest" }
    }).then(res => res.json());

    let decryptData = null;

    try {
      decryptData = await extractMegaCloud(sourcesJson.link);
    } catch (err) {
      console.warn("Primary decrypter failed:", err);
    }
    
    // Fallback to ShadeOfChaos if primary fails or no valid data
    if (!decryptData) {
      console.warn("Primary decrypter failed — trying ShadeOfChaos fallback...");
      const fallbackRes = await fetch(
        `https://ac-api.ofchaos.com/api/anime/embed/convert/v2?embedUrl=${encodeURIComponent(sourcesJson.link)}`
      );
      decryptData = await fallbackRes.json();
    }

    // Get HLS or MP4 stream
    const streamSource =
      decryptData.sources.find((s: any) => s.type === "hls") ||
      decryptData.sources.find((s: any) => s.type === "mp4");
  
    if (!streamSource?.file) throw new Error("No valid stream file found");
  
    // Map subtitles
    const subtitles =
      (decryptData.tracks || [])
        .filter((t: any) => t.kind === "captions")
        .map((track: any, index: number) => ({
          id: `sub-${index}`,
          language: track.label || "Unknown",
          url: track.file,
          isDefault: !!track.default,
        }));
  
      return {
        server: serverName,
        headers: {
          "Referer": "https://megacloud.club/",
          "Origin": "https://megacloud.club",
          "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
        },
        videoSources: [{
            url: streamSource.file,
            type: streamSource.type === "hls" ? "m3u8" : "mp4",
            quality: "auto",
            subtitles
        }]
    };
  }
}

async function extractMegaCloud(embedUrl: string) {
  const url = new URL(embedUrl);
  const baseDomain = `${url.protocol}//${url.host}/`;

  const headers = {
    "Accept": "*/*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": baseDomain,
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
  };

  // Fetch embed page
  const html = await fetch(embedUrl, { headers }).then((r) => r.text());

  // Extract file ID
  const fileIdMatch = html.match(/<title>\s*File\s+#([a-zA-Z0-9]+)\s*-/i);
  if (!fileIdMatch) throw new Error("file_id not found in embed page");
  const fileId = fileIdMatch[1];

  // Extract nonce
  let nonce: string | null = null;
  const match48 = html.match(/\b[a-zA-Z0-9]{48}\b/);
  if (match48) nonce = match48[0];
  else {
    const match3x16 = [...html.matchAll(/["']([A-Za-z0-9]{16})["']/g)];
    if (match3x16.length >= 3) {
      nonce = match3x16[0][1] + match3x16[1][1] + match3x16[2][1];
    }
  }
  if (!nonce) throw new Error("nonce not found");

  // Fetch sources
  const sourcesJson = await fetch(
    `${baseDomain}embed-2/v3/e-1/getSources?id=${fileId}&_k=${nonce}`,
    { headers }
  ).then((r) => r.json());

  return {
    sources: sourcesJson.sources,
    tracks: sourcesJson.tracks || [],
    intro: sourcesJson.intro || null,
    outro: sourcesJson.outro || null,
    server: sourcesJson.server || null,
  };
}
