/**
 * U Street Hunt — Core Application Engine
 * Supabase client, auth, points, stamps, leaderboard, prizes
 */

// ── Supabase Client ──
const SUPABASE_URL = 'https://aayigsbmmdolvnicxacs.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ofAZ_64cKZXJefM5nbbt3g_wNOoF5DC';

let _sb;

function initSupabase() {
  if (_sb) return _sb;
  if (typeof window.supabase?.createClient === 'function') {
    _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _sb;
}

// ── Session ──
let currentUser = null;
let userPoints = 0;
let userStamps = [];
let spinTokens = 0;

function getSession() {
  const raw = localStorage.getItem('ustreet_hunt_session');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function setSession(user) {
  currentUser = user;
  localStorage.setItem('ustreet_hunt_session', JSON.stringify(user));
}

function clearSession() {
  currentUser = null;
  userPoints = 0;
  userStamps = [];
  spinTokens = 0;
  localStorage.removeItem('ustreet_hunt_session');
}

function isLoggedIn() {
  return !!getSession();
}

// ── Phone Auth ──
async function sendOTP(phone) {
  const sb = initSupabase();
  const clean = phone.replace(/[^\d+]/g, '');
  const formatted = clean.startsWith('+') ? clean : `+1${clean}`;
  const { data, error } = await sb.auth.signInWithOtp({ phone: formatted });
  return { data, error };
}

async function verifyOTP(token) {
  const raw = localStorage.getItem('otp_phone');
  if (!raw) return { error: { message: 'No phone found. Please re-enter.' } };
  const phone = JSON.parse(raw);

  const sb = initSupabase();
  const { data, error } = await sb.auth.verifyOtp({
    phone,
    token,
    type: 'sms',
  });

  if (!error && data?.user) {
    // Create/update hunter profile
    const profile = await ensureProfile(data.user);
    setSession({ ...profile, userId: data.user.id });
    currentUser = profile;
  }

  return { data, error };
}

async function ensureProfile(authUser) {
  const sb = initSupabase();
  const { data: existing } = await sb
    .from('hunters')
    .select('*')
    .eq('id', authUser.id)
    .maybeSingle();

  if (existing) return existing;

  // Build display name from phone
  const phone = authUser.phone || '';
  const displayName = `Hunter_${phone.slice(-4)}`;

  const { data: created } = await sb
    .from('hunters')
    .insert({
      id: authUser.id,
      display_name: displayName,
      phone,
      total_points: 0,
      spin_tokens: 0,
    })
    .select()
    .single();

  return created || { id: authUser.id, display_name: displayName, total_points: 0, spin_tokens: 0 };
}

// ── Points & Stamps ──
async function loadUserData() {
  const session = getSession();
  if (!session?.userId) return;

  const sb = initSupabase();

  const [{ data: profile }, { data: stamps }] = await Promise.all([
    sb.from('hunters').select('*').eq('id', session.userId).maybeSingle(),
    sb.from('stamps').select('*').eq('user_id', session.userId),
  ]);

  if (profile) {
    currentUser = { ...profile, userId: profile.id };
    userPoints = profile.total_points || 0;
    spinTokens = profile.spin_tokens || 0;
    setSession(currentUser);
  }

  if (stamps) {
    userStamps = stamps.map(s => s.checkpoint_id);
  }
}

async function earnStamp(checkpointId, checkpointName, points) {
  const session = getSession();
  if (!session?.userId) return { error: 'Not logged in' };

  const sb = initSupabase();

  // Check duplicate
  const { data: existing } = await sb
    .from('stamps')
    .select('id')
    .eq('user_id', session.userId)
    .eq('checkpoint_id', checkpointId)
    .maybeSingle();

  if (existing) return { error: 'Already stamped this checkpoint' };

  // Insert stamp
  const { error: stampErr } = await sb
    .from('stamps')
    .insert({
      user_id: session.userId,
      checkpoint_id: checkpointId,
      points_earned: points,
      scanned_at: new Date().toISOString(),
    });

  if (stampErr) return { error: stampErr.message };

  // Update hunter points
  const newPoints = userPoints + points;
  const newSpins = Math.floor(userStamps.length / 3) + (userStamps.length % 3 === 2 ? 1 : 0);

  const { error: updateErr } = await sb
    .from('hunters')
    .update({ total_points: newPoints, spin_tokens: newSpins })
    .eq('id', session.userId);

  if (updateErr) return { error: updateErr.message };

  // Update local state
  userPoints = newPoints;
  spinTokens = newSpins;
  userStamps.push(checkpointId);

  setSession({ ...currentUser, total_points: newPoints, spin_tokens: newSpins });

  return { success: true, checkpoint: checkpointName, points, totalPoints: newPoints };
}

async function useSpinToken() {
  const session = getSession();
  if (!session?.userId || spinTokens < 1) return { error: 'No spins available' };

  const sb = initSupabase();
  const newSpins = spinTokens - 1;

  await sb
    .from('hunters')
    .update({ spin_tokens: newSpins })
    .eq('id', session.userId);

  spinTokens = newSpins;
  setSession({ ...currentUser, spin_tokens: newSpins });

  return { success: true, remainingSpins: newSpins };
}

// ── Leaderboard ──
async function getLeaderboard(limit = 25) {
  const sb = initSupabase();
  const { data, error } = await sb
    .from('hunters')
    .select('id, display_name, total_points')
    .order('total_points', { ascending: false })
    .limit(limit);

  if (error) return [];
  return data || [];
}

async function getUserRank() {
  const session = getSession();
  if (!session?.userId) return null;

  const sb = initSupabase();
  const { data, error } = await sb.rpc('get_user_rank', { uid: session.userId });

  // Fallback: count manually
  if (error || !data) {
    const { count } = await sb
      .from('hunters')
      .select('*', { count: 'exact', head: true })
      .gt('total_points', userPoints);
    return (count || 0) + 1;
  }

  return data;
}

// ── Checkpoints Data (Hardcoded for offline + fallback) ──
// Types: 'hq' | 'checkpoint' | 'bonus' | 'landmark'
// Landmarks = free cultural stops, no purchase required, staff-verified or self-check QR
const CHECKPOINTS = [
  // ── HQ ──
  { id: 'cookies-dc',    name: 'Cookies DC',          address: '1115 U St NW, Washington, DC 20009',    lat: 38.91720, lng: -77.02779, points: 0,  type: 'hq',        perk: 'Registration & Redemption HQ — Start & finish here',            emoji: '🍪', word: 'PASSPORT',  lore: 'U Street has been called "The Black Broadway" since the 1920s. This block hosted Duke Ellington, Ella Fitzgerald, and Billie Holiday when segregation banned them from playing downtown. Cookies DC is carrying that legacy of Black excellence forward.' },

  // ── Commercial Stops ──
  { id: 'jenis',         name: "Jeni's Ice Cream",    address: '1631 U St NW, Washington, DC 20009',    lat: 38.91683, lng: -77.03768, points: 10, type: 'checkpoint', perk: 'Free scoop with any purchase',                                  emoji: '🍦', word: 'SCOOP',     lore: 'This stretch of U Street was the heart of DC\'s go-go scene in the \'80s. Bands like Trouble Funk and Chuck Brown & the Soul Searchers played venues within a few blocks of here — a sound born right on this corridor.' },
  { id: 'chicken-rico',  name: 'Chicken Rico',        address: '1710 14th St NW, Washington, DC 20009', lat: 38.91780, lng: -77.03190, points: 10, type: 'checkpoint', perk: 'Free side with any order',                                      emoji: '🐔', word: 'RICO',      lore: '14th and U was ground zero for the 1968 riots after MLK\'s assassination. The community rebuilt itself here, block by block. Every business standing on this corner today is a testament to that resilience.' },
  { id: 'nellies',       name: "Nellie's Sports Bar", address: '900 U St NW, Washington, DC 20001',     lat: 38.91688, lng: -77.02430, points: 10, type: 'checkpoint', perk: '10% off your tab with passport',                               emoji: '🏳️‍🌈', word: 'NELLIE',    lore: 'U Street has always been a corridor of radical acceptance. DC\'s LGBTQ+ community has been part of this neighborhood\'s fabric for decades — Nellie\'s is one of the anchors of that ongoing story.' },
  { id: '1942-lounge',   name: 'District Sports Bar', address: '1344 U St NW, Washington, DC 20009',    lat: 38.91734, lng: -77.03156, points: 10, type: 'checkpoint', perk: '10% off first drink',                                           emoji: '🏀', word: 'GAME',      lore: 'The Lincoln Theatre, just down the block, was the premier Black entertainment venue in DC from the 1920s onward. Nat King Cole, Louis Armstrong, and Cab Calloway all performed there. This whole strip was the social center of Black DC.' },
  { id: 'tipsy-hookah',  name: 'Tipsy Hookah Lounge', address: '1212 U St NW, Washington, DC 20009',   lat: 38.91715, lng: -77.02889, points: 10, type: 'checkpoint', perk: 'Free tea with any hookah',                                      emoji: '💨', word: 'SMOKE',     lore: 'Black Flag played shows near this corridor in the early \'80s when U Street was a punk and alternative music hub. Henry Rollins, who grew up in DC, was part of a scene that mixed with the neighborhood\'s funk and go-go roots in ways no other city ever replicated.' },
  { id: 'oohs-and-ahhs', name: 'Oohs & Ahhs',         address: '1005 U St NW, Washington, DC 20001',   lat: 38.91708, lng: -77.02618, points: 10, type: 'checkpoint', perk: 'Free dessert with entree',                                      emoji: '🍽️', word: 'COMFORT',   lore: 'Soul food has always been the fuel of U Street. During the Great Migration, thousands of Black families from the South brought their cooking traditions to DC — the comfort food on this corridor is a living archive of that history.' },
  { id: 'spicy-water',   name: 'Spicy Water',          address: '1342 U St NW, Washington, DC 20009',   lat: 38.91733, lng: -77.03150, points: 10, type: 'checkpoint', perk: 'Free drink on arrival with passport',                           emoji: '🌶️', word: 'SPICY',     lore: 'By the 1990s, U Street had become the center of DC\'s indie music and nightlife revival. Clubs like the 9:30 Club (nearby) and spaces on this corridor helped launch careers of artists who went on to define an era of American music.' },
  { id: 'bens',          name: "Ben's Next Door",      address: '1211 U St NW, Washington, DC 20009',   lat: 38.91712, lng: -77.02878, points: 20, type: 'bonus',      perk: "Free chili dog with any purchase — BONUS stop",                emoji: '🌭', word: 'HALFSMOKE', lore: "Ben's Chili Bowl opened in 1958 and never closed — not during the riots, not during crack, not during COVID. Bill Cosby, Donnie Simpson, and Barack Obama have all eaten here. The Half-Smoke is not a meal. It\'s a monument." },
  { id: 'chi-cha',       name: 'Chi-Cha Lounge',       address: '1624 U St NW, Washington, DC 20009',   lat: 38.91682, lng: -77.03752, points: 15, type: 'checkpoint', perk: 'After party venue — free entry before midnight with passport',   emoji: '🌙', word: 'FINALE',    lore: 'Duke Ellington was born just blocks from U Street in 1899. He grew up hearing the sounds of this neighborhood before he went on to define American jazz. Every time music plays on U Street, it echoes something he started.' },

  // ── Cultural Landmark Stops (no purchase required — walk up, absorb, earn) ──
  {
    id: 'lincoln-theatre',
    name: 'Lincoln Theatre',
    address: '1215 U St NW, Washington, DC 20009',
    lat: 38.91715, lng: -77.02898,
    points: 15,
    type: 'landmark',
    perk: 'Stand here. This is where Black Broadway lived. Take the photo. Tag us.',
    emoji: '🎭',
    word: 'LINCOLN',
    lore: 'Opened in 1922, the Lincoln Theatre was the crown jewel of "The Black Broadway." Duke Ellington, Cab Calloway, Ella Fitzgerald, Louis Armstrong, and Billie Holiday all performed on this stage during an era when segregation banned Black artists from performing downtown. The Lincoln was more than a venue — it was proof that Black culture didn\'t need white validation to be world-class. It closed in the \'70s, sat vacant for years, and was restored in 1994. It still stands. So does everything it represents.',
    symbolChallenge: {
      question: 'Which of these symbols is actually from DC?',
      options: [
        { label: 'Bad Brains lightning bolt ⚡', correct: true,  fact: '100% DC. Bad Brains formed in Washington DC in 1976. The lightning bolt became one of the most recognized symbols in punk/reggae history — born right here on this corridor.' },
        { label: 'Nirvana smiley face 🙂',       correct: false, fact: 'That\'s Seattle, WA — not DC. Kurt Cobain drew it in 1991. Different coast, different scene.' },
        { label: 'Black Flag bars 🟥',            correct: false, fact: 'Close — Black Flag was from Hermosa Beach, California. Though Henry Rollins, their most iconic singer, is from DC and brought the city\'s intensity to the band.' },
      ]
    }
  },
  {
    id: 'bad-brains-corner',
    name: 'Bad Brains Corner',
    address: '1813 Columbia Rd NW (near U St corridor), Washington, DC 20009',
    lat: 38.92200, lng: -77.03800,
    points: 15,
    type: 'landmark',
    perk: 'Find the spot. Know the story. This is where DC hardcore was born.',
    emoji: '⚡',
    word: 'BADBRAINS',
    lore: 'Bad Brains formed in Washington DC in 1976 — four Black teenagers who started as a jazz-fusion band and transformed into the most ferocious punk act on earth. They invented what would become hardcore punk, influenced the Beastie Boys, Red Hot Chili Peppers, and nearly every alternative band of the \'80s and \'90s. H.R.\'s stage dives were legendary. They were banned from venues. They didn\'t care. The Bad Brains lightning bolt is one of the most powerful symbols in music history — designed by a DC crew who refused to be put in a box. This is their city.',
    symbolChallenge: {
      question: 'Bad Brains were pioneers of what genre?',
      options: [
        { label: 'Hardcore punk / reggae fusion', correct: true,  fact: 'Correct. They invented the template for hardcore punk AND blended it with Rastafarian reggae. No band before or since has pulled that off at that level.' },
        { label: 'Grunge',                         correct: false, fact: 'Grunge came from Seattle in the late \'80s/early \'90s — Pearl Jam, Nirvana, Soundgarden. Bad Brains predated and influenced it.' },
        { label: 'Trap music',                     correct: false, fact: 'Trap originated in Atlanta in the early 2000s. Bad Brains were doing something completely different — and 25 years earlier.' },
      ]
    }
  },
  {
    id: 'ellington-birthplace',
    name: 'Duke Ellington Birthplace',
    address: '2129 Ward Pl NW, Washington, DC 20037',
    lat: 38.91370, lng: -77.04790,
    points: 15,
    type: 'landmark',
    perk: 'Stand where genius began. Edward Kennedy Ellington was born in this neighborhood.',
    emoji: '🎹',
    word: 'DUKE',
    lore: 'Edward Kennedy "Duke" Ellington was born on April 29, 1899, just blocks from U Street. He grew up on these streets, took piano lessons nearby, and absorbed the sound of Black DC before he went on to become one of the greatest composers in American history. He led his orchestra for over 50 years, wrote over 3,000 compositions, and transformed jazz into high art — all while never forgetting where he came from. The neighborhood shaped him. He shaped the world.',
    symbolChallenge: {
      question: 'Duke Ellington\'s hometown sound that shaped his music was:',
      options: [
        { label: 'DC\'s "Black Broadway" jazz scene', correct: true,  fact: 'Yes. U Street was the heart of DC\'s jazz world, and Ellington absorbed it as a child before becoming one of the genre\'s defining figures.' },
        { label: 'New Orleans blues',                  correct: false, fact: 'New Orleans gave us a different lineage — Louis Armstrong, Jelly Roll Morton. Ellington\'s roots were DC through and through.' },
        { label: 'Chicago gospel',                     correct: false, fact: 'Chicago\'s music scene was transformative, but Ellington\'s origin story starts here on U Street, not the South Side.' },
      ]
    }
  },
];

function getCheckpoint(id) {
  return CHECKPOINTS.find(c => c.id === id) || null;
}

// ── Team Code Generator ──
// Generates a short, readable 6-char alphanumeric code (no 0/O/I/1 confusion)
function generateTeamCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ── Edit Profile (call from any page) ──
async function editProfile({ displayName, teamName, teamCode }) {
  const session = getSession();
  if (!session?.userId) return { error: 'Not logged in' };
  const sb = initSupabase();
  const updates = {};
  if (displayName !== undefined) updates.display_name = displayName;
  if (teamName !== undefined) updates.team_name = teamName || null;
  if (teamCode !== undefined) updates.team_code = teamCode || null;
  const { error } = await sb.from('hunters').update(updates).eq('id', session.userId);
  if (!error) {
    currentUser = { ...currentUser, ...updates };
    setSession({ ...session, ...updates });
  }
  return { error: error?.message || null };
}

// ── Prize Wheel Prizes ──
// Each slot shows the donating business so players associate the win with that location.
const WHEEL_PRIZES = [
  { label: 'Free Scoop',      emoji: '🍦', color: '#5b9dff',  sponsor: "Jeni's Ice Cream",    desc: "Walk in and show this — free scoop on Jeni's." },
  { label: 'Cookies Sticker', emoji: '🍪', color: '#1a73e8',  sponsor: 'Cookies DC',           desc: 'Limited edition Cookies DC sticker pack.' },
  { label: '+10 Bonus Pts',   emoji: '⭐', color: '#3d7be8',  sponsor: null,                   desc: '10 bonus points added to your passport.' },
  { label: 'Free Tea',        emoji: '💨', color: '#7b5dff',  sponsor: 'Tipsy Hookah Lounge',  desc: 'Free tea with any hookah session at Tipsy.' },
  { label: 'Free Dessert',    emoji: '🍽️', color: '#e8a020',  sponsor: 'Oohs & Ahhs',          desc: 'Free dessert with any entree at Oohs & Ahhs.' },
  { label: 'Free Drink',      emoji: '🌶️', color: '#20c870',  sponsor: 'Spicy Water',           desc: 'Free drink on arrival at Spicy Water.' },
  { label: 'Try Again',       emoji: '🔄', color: '#4a5a7a',  sponsor: null,                   desc: 'Better luck next spin!' },
  { label: 'Free Chili Dog',  emoji: '🌭', color: '#c85020',  sponsor: "Ben's Next Door",       desc: "Free chili dog with any order at Ben's Next Door." },
  { label: 'Cookies Merch',   emoji: '🧢', color: '#1560cc',  sponsor: 'Cookies DC',           desc: 'Cookies DC branded merch — claimed at HQ.' },
  { label: '+15 Bonus Pts',   emoji: '🔥', color: '#d47010',  sponsor: null,                   desc: '15 bonus points — big jump on the leaderboard.' },
];

// ── Confetti ──
function launchConfetti() {
  const container = document.createElement('div');
  container.className = 'confetti-container';
  const colors = ['#5b9dff', '#1a73e8', '#cfe0ff', '#9db8ff', '#f0c850', '#f4f8ff'];

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + '%';
    piece.style.animationDelay = Math.random() * .6 + 's';
    piece.style.animationDuration = (Math.random() * 1 + 1.2) + 's';
    piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    piece.style.width = (Math.random() * 8 + 6) + 'px';
    piece.style.height = (Math.random() * 8 + 6) + 'px';
    container.appendChild(piece);
  }

  document.body.appendChild(container);
  setTimeout(() => container.remove(), 2200);
}

// ── XSS-safe HTML escape ──
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}

// ── Toast ──
function showToast(message, type = '') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

// ── Twilio SMS (via Supabase Edge Function) ──
async function sendSMS(phoneDigits, message) {
  const sb = initSupabase();
  try {
    const { error } = await sb.functions.invoke('send-sms', {
      body: { to: phoneDigits, message }
    });
    if (error) {
      console.warn('Edge function error, falling back to native SMS:', error);
      const sep = /iPad|iPhone|iPod/.test(navigator.userAgent) ? '&' : '?';
      window.open('sms:' + phoneDigits + sep + 'body=' + encodeURIComponent(message), '_blank');
    }
    return true;
  } catch(e) {
    console.warn('Edge function unavailable:', e);
    const sep = /iPad|iPhone|iPod/.test(navigator.userAgent) ? '&' : '?';
    window.open('sms:' + phoneDigits + sep + 'body=' + encodeURIComponent(message), '_blank');
    return true;
  }
}

// ── Welcome SMS after registration ──
async function sendWelcomeSMS(phoneDigits, hunterName) {
  const msg = '🍪 Welcome to the U Street Passport, ' + hunterName + '! Your passport is live. Hit the corridor on July 11 — collect stamps, earn points, win prizes. Anchored at Cookies DC. Map: https://ustreet-hunt.atcheofficial.com/map.html';
  return sendSMS(phoneDigits, msg);
}


// ── Countdown ──
function getLaunchDate() {
  return new Date('2026-07-11T12:00:00-04:00');
}

function getCountdownParts() {
  const now = new Date();
  const launch = getLaunchDate();
  const diff = launch - now;

  if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, launched: true };

  return {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
    launched: false,
  };
}

// ── Navigation Highlight ──
function highlightNav() {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-item').forEach(item => {
    const href = item.getAttribute('href') || '';
    item.classList.toggle('active', href === path || (path === '' && href === 'index.html'));
  });
}

// ── Bottom Nav Inject ──
function injectBottomNav() {
  if (document.querySelector('.bottom-nav')) return;

  const nav = document.createElement('nav');
  nav.className = 'bottom-nav';
  nav.innerHTML = `
    <a href="index.html" class="nav-item">
      <span class="nav-icon">🏠</span>
      <span>Home</span>
    </a>
    <a href="hunt.html" class="nav-item">
      <span class="nav-icon">📘</span>
      <span>Passport</span>
    </a>
    <a href="map.html" class="nav-item">
      <span class="nav-icon">🗺️</span>
      <span>Map</span>
    </a>
    <a href="leaderboard.html" class="nav-item">
      <span class="nav-icon">🏆</span>
      <span>Ranks</span>
    </a>
    <a href="prizes.html" class="nav-item">
      <span class="nav-icon">🎁</span>
      <span>Prizes</span>
    </a>
  `;
  document.body.appendChild(nav);
  highlightNav();
}

// ── PWA Registration ──
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(() => console.log('SW registered'))
      .catch(err => console.warn('SW registration failed:', err));
  }
}

// ── PWA Install Prompt ──
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

async function promptInstall() {
  if (!deferredPrompt) {
    showToast('App is already installed, or your browser doesn\'t support this.');
    return;
  }
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  if (outcome === 'accepted') showToast('App installed! 🍪');
}

// ── Init on load ──
document.addEventListener('DOMContentLoaded', () => {
  registerSW();
  injectBottomNav();
  if (getSession()) {
    currentUser = getSession();
    loadUserData();
  }
});
