// 13주차 사전과제 자동 점검 봇
// - 학생 PR에서 submissions/<아이디>.md 파일을 "데이터로만" 읽습니다 (학생 코드를 checkout·실행하지 않음)
// - 배포 URL 접속 여부, GitHub Pages 주소 주인, 주차별 원본 저장소 PR 제출 여부를 점검합니다
// - 결과: result_comment.txt / status.txt(PASS|RETRY) / summary.txt, 그리고 $GITHUB_ENV에 PR 메타데이터
const fs = require('fs');

const ORG = 'kopo-kangseo-cybersec';
const REPO = process.env.GITHUB_REPOSITORY; // kopo-kangseo-cybersec/26-final-checkup
const TOKEN = process.env.GITHUB_TOKEN;
const PR_NUMBER = process.env.PR_NUMBER;
const URL_TIMEOUT_MS = 15000;

// 점검 대상: 4주차 ~ 12주차
const TARGETS = [
  { week: '4주', repo: '26-w04-calculator', label: '계산기', deploys: ['Pages'] },
  { week: '4주', repo: '26-w04-profilecard', label: '프로필 카드', deploys: ['Pages'] },
  { week: '5주', repo: '26-w05-web-inline', label: '보안회사 웹사이트 (인라인)', deploys: ['Pages'] },
  { week: '5주', repo: '26-w05-web-plan', label: '보안회사 웹사이트 (Plan)', deploys: ['Pages'] },
  { week: '6주', repo: '26-w06-apple', label: '사과게임', deploys: ['Pages'] },
  { week: '7주', repo: '26-w06-minesweeper', label: '지뢰찾기', deploys: ['Pages'] },
  { week: '8주', repo: '26-w08-todo', label: '투두리스트', deploys: ['Pages'] },
  { week: '9주', repo: '26-w09-diary', label: '감정 일기', deploys: ['Netlify', 'Pages'] },
  { week: '10주', repo: '26-w10-weather', label: '날씨·미세먼지 대시보드', deploys: ['Netlify', 'Pages'] },
  { week: '11주', repo: '26-w11-mobile-otp', label: '모바일 OTP', deploys: ['Netlify', 'Pages'] },
  { week: '12주', repo: '26-w12-password', label: '비밀번호 보안 도구', deploys: ['Netlify', 'Pages'] },
];

async function gh(path, accept = 'application/vnd.github+json') {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${path}`);
  return accept.includes('raw') ? res.text() : res.json();
}

// ---------- 1. 제출 파일 파싱 ----------
function parseSubmission(text) {
  const name = (text.match(/^\s*-\s*이름\s*:\s*(.*)$/m) || [])[1]?.trim() || '';
  const urls = {}; // key: "repo|Pages"
  const re = /^\s*-\s*(26-w\d{2}-[a-z0-9-]+)\s*\((pages|netlify)\)\s*:\s*(.*)$/gim;
  let m;
  while ((m = re.exec(text))) {
    const deploy = m[2].toLowerCase() === 'pages' ? 'Pages' : 'Netlify';
    const raw = m[3].trim().replace(/^<|>$/g, '').split(/\s+/)[0] || '';
    urls[`${m[1].toLowerCase()}|${deploy}`] = raw;
  }
  return { name, urls };
}

// ---------- 2. URL 형식 검사 (요청 전) ----------
function validateUrl(raw, deploy, author) {
  if (!raw) return { ok: false, reason: '미입력' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: '주소 형식 오류' }; }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.startsWith('127.')) return { ok: false, reason: '로컬 주소 (배포 주소 아님)' };
  if (u.protocol !== 'https:') return { ok: false, reason: 'https 주소가 아님' };
  if (host === 'github.com' || raw.endsWith('.git')) return { ok: false, reason: '저장소 주소 (배포 주소 아님)' };
  if (deploy === 'Pages') {
    if (!host.endsWith('.github.io')) return { ok: false, reason: 'github.io 주소가 아님' };
    if (host !== `${author.toLowerCase()}.github.io`) return { ok: false, reason: `내 아이디(${author})의 주소가 아님` };
  } else if (!host.endsWith('.netlify.app')) {
    // 봇이 임의의 사이트로 요청을 보내지 않도록 배포 도메인만 허용합니다
    return { ok: false, reason: 'netlify.app 주소가 아님' };
  }
  return { ok: true, url: u };
}

async function checkReachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': '26-final-checkup-bot' } });
    return res.ok ? { ok: true, reason: `${res.status}` } : { ok: false, reason: `접속 실패 (${res.status})` };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '응답 시간 초과' : '접속 불가' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 3. 주차별 원본 저장소 PR 찾기 ----------
async function findPr(repo, author) {
  const login = author.toLowerCase();
  let mine = [];
  for (let page = 1; page <= 5; page++) {
    const pulls = await gh(`/repos/${ORG}/${repo}/pulls?state=all&per_page=100&page=${page}`);
    mine = mine.concat(pulls.filter((p) => p.user?.login?.toLowerCase() === login));
    if (pulls.length < 100) break;
  }
  if (!mine.length) return null;
  mine.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const p = mine[0];
  return { number: p.number, url: p.html_url, state: p.state, labels: p.labels.map((l) => l.name) };
}

async function main() {
  const pr = await gh(`/repos/${REPO}/pulls/${PR_NUMBER}`);
  const author = pr.user.login;
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `PR_AUTHOR=${author}\nPR_URL=${pr.html_url}\n`);
  }

  const problems = [];
  const files = await gh(`/repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100`);
  const expected = `submissions/${author}.md`.toLowerCase();
  const subFile = files.find((f) => f.filename.toLowerCase() === expected && f.status !== 'removed');
  const others = files.filter((f) => !f.filename.toLowerCase().startsWith('submissions/'));

  if (others.length) {
    problems.push(`제출 파일 외에 다른 파일이 변경되었습니다: ${others.map((f) => `\`${f.filename}\``).join(', ')} — 해당 변경을 되돌려 주세요.`);
  }
  if (!subFile) {
    const found = files.filter((f) => f.filename.startsWith('submissions/')).map((f) => `\`${f.filename}\``);
    const hint = found.length ? ` (제출된 파일: ${found.join(', ')})` : '';
    writeResult(author, '', [], [], [`\`submissions/${author}.md\` 파일을 찾을 수 없습니다. 파일 이름이 GitHub 아이디와 정확히 같은지 확인해 주세요.${hint}`, ...problems]);
    return;
  }

  const text = await gh(new URL(subFile.contents_url).pathname + new URL(subFile.contents_url).search, 'application/vnd.github.raw');
  const { name, urls } = parseSubmission(text);

  // 배포 링크 점검 (동시에 요청)
  const linkRows = await Promise.all(
    TARGETS.flatMap((t) =>
      t.deploys.map(async (deploy) => {
        const raw = urls[`${t.repo}|${deploy}`] || '';
        const v = validateUrl(raw, deploy, author);
        const r = v.ok ? await checkReachable(v.url.href) : v;
        return { ...t, deploy, raw, ok: r.ok, reason: r.reason };
      })
    )
  );

  // PR 점검
  const prRows = await Promise.all(
    TARGETS.map(async (t) => {
      try {
        return { ...t, pr: await findPr(t.repo, author) };
      } catch (e) {
        return { ...t, pr: null, error: e.message };
      }
    })
  );

  writeResult(author, name, linkRows, prRows, problems);
}

function writeResult(author, name, linkRows, prRows, problems) {
  const linkFails = linkRows.filter((r) => !r.ok).length;
  const prFails = prRows.filter((r) => !r.pr).length;
  const pass = problems.length === 0 && linkRows.length > 0 && linkFails === 0 && prFails === 0;

  let md = `### 🔎 13주차 사전과제 자동 점검 결과 (${name || author} · @${author})\n\n`;

  if (problems.length) {
    md += `#### ⚠️ 제출 형식 확인\n${problems.map((p) => `- ${p}`).join('\n')}\n\n`;
  }

  if (linkRows.length) {
    md += `#### 🌐 배포 링크 점검 (${linkRows.length - linkFails}/${linkRows.length} 통과)\n\n`;
    md += `| 주차 | 결과물 | 배포 | 결과 | 주소 |\n|:---:|---|:---:|:---:|---|\n`;
    for (const r of linkRows) {
      const shown = r.raw ? r.raw.replace(/\|/g, '%7C') : '—';
      md += `| ${r.week} | ${r.label} | ${r.deploy} | ${r.ok ? '✅' : `❌ ${r.reason}`} | ${shown} |\n`;
    }
    md += '\n';
  }

  if (prRows.length) {
    md += `#### 📬 주차별 PR 제출 점검 (${prRows.length - prFails}/${prRows.length} 확인)\n\n`;
    md += `| 주차 | 저장소 | 결과 | PR | 상태·라벨 |\n|:---:|---|:---:|---|---|\n`;
    for (const r of prRows) {
      if (r.pr) {
        const labels = r.pr.labels.length ? ` · ${r.pr.labels.join(', ')}` : '';
        md += `| ${r.week} | \`${r.repo}\` | ✅ | [#${r.pr.number}](${r.pr.url}) | ${r.pr.state}${labels} |\n`;
      } else {
        md += `| ${r.week} | \`${r.repo}\` | ❌ ${r.error ? '조회 오류' : 'PR 없음'} | — | — |\n`;
      }
    }
    md += '\n';
  }

  md += `> 💡 봇은 **페이지가 열리는지**와 **PR이 있는지**까지만 확인합니다. 기능 동작은 13주차 수업에서 함께 확인합니다.\n\n`;
  md += `#### 🎯 종합 판정: ${pass ? '[통과 (PASS)]' : '[보완 필요]'}\n`;
  if (!pass) md += `\n❌ 표시된 항목을 고친 뒤 **같은 PR에 다시 커밋**하면 자동으로 다시 점검합니다.\n`;

  fs.writeFileSync('result_comment.txt', md);
  fs.writeFileSync('status.txt', pass ? 'PASS' : 'RETRY');
  fs.writeFileSync(
    'summary.txt',
    pass ? '통과 (PASS)' : `보완 필요 — 링크 ❌ ${linkFails}건, PR ❌ ${prFails}건${problems.length ? ', 형식 오류' : ''}`
  );
  console.log(md);
}

module.exports = { parseSubmission, validateUrl, TARGETS };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    fs.writeFileSync('result_comment.txt', `### ⚠️ 자동 점검 중 오류가 발생했습니다\n교수가 직접 확인할 예정입니다.\n\n\`${e.message}\``);
    fs.writeFileSync('status.txt', 'RETRY');
    fs.writeFileSync('summary.txt', '점검 오류');
  });
}
