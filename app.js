/**
 * U Street Hunt — Core Application Engine
 * Supabase client, auth, points, stamps, leaderboard, prizes
 */

// ── Supabase Client ──
const SUPABASE_URL = 'https://aayigsbmmdolvnicxacs.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ofAZ_64cKZXJefM5nbbt3g_wNOoF5DC';

let supabase;

function initSupabase() {
  if (typeof supabase !== 'undefined' && supabase) return supabase;
  if (typeof window.supabase?.createClient === 'function') {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabase;
}

// ── Session ──
let currentUser = null;
let userPoints = 0;
let userStamps = [];
let spinTokens = 0;

function getSession() {
  const raw = sessionStorage.getItem('ustreet_hunt_session');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function setSession(user) {
  currentUser = user;
  sessionStorage.setItem('ustreet_hunt_session', JSON.stringify(user));
}

function clearSession() {
  currentUser = null;
  userPoints = 0;
  userStamps = [];
  spinTokens = 0;
  sessionStorage.removeItem('ustreet_hunt_session');
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
  const raw = sessionStorage.getItem('otp_phone');
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
const CHECKPOINTS = [
  { id: 'cookies-dc', name: 'Cookies DC', address: '1115 U St NW, Washington, DC 20009', lat: 38.91720, lng: -77.02779, points: 0, type: 'hq', perk: 'Registration & Redemption HQ — Start & finish here', emoji: '🍪' },
  { id: 'whitlows', name: "Whitlow's", address: '901 U St NW, Washington, DC 20001', lat: 38.91690, lng: -77.02449, points: 10, type: 'checkpoint', perk: '$5 appetizer menu with passport', emoji: '🍔' },
  { id: 'service-bar', name: 'Service Bar', address: '926-928 U St NW, Washington, DC 20001', lat: 38.91700, lng: -77.02492, points: 10, type: 'checkpoint', perk: 'Free side with any order', emoji: '🍹' },
  { id: 'oohs-and-ahhs', name: 'Oohs & Ahhs', address: '1005 U St NW, Washington, DC 20001', lat: 38.91708, lng: -77.02618, points: 10, type: 'checkpoint', perk: 'Free dessert with entree', emoji: '🍽️' },
  { id: 'tipsy-hookah', name: 'Tipsy Hookah Lounge', address: '1212 U St NW, Washington, DC 20009', lat: 38.91715, lng: -77.02889, points: 10, type: 'checkpoint', perk: 'Free tea with any hookah', emoji: '💨' },
  { id: 'pure', name: 'Pure Lounge', address: '1326 U St NW, Washington, DC 20009', lat: 38.91732, lng: -77.03124, points: 10, type: 'checkpoint', perk: 'Free entry before 11pm with passport', emoji: '🎵' },
  { id: '1942-lounge', name: '1942 Lounge', address: '1344 U St NW, Washington, DC 20009', lat: 38.91734, lng: -77.03156, points: 10, type: 'checkpoint', perk: '10% off first drink', emoji: '🥃' },
  { id: 'dna', name: 'DNA Lounge', address: '1350 U St NW, Washington, DC 20009', lat: 38.91737, lng: -77.03187, points: 10, type: 'checkpoint', perk: 'Buy one get one half off', emoji: '🧬' },
  { id: 'chi-cha', name: 'Chi-Cha Lounge', address: '1624 U St NW, Washington, DC 20009', lat: 38.91682, lng: -77.03752, points: 10, type: 'checkpoint', perk: '10% off hookah + Finale venue', emoji: '🌙' },
  { id: 'ebbitt', name: 'Old Ebbitt Grill', address: '675 15th St NW, Washington, DC 20005', lat: 38.89744, lng: -77.03318, points: 20, type: 'bonus', perk: 'Late-night food til 2am — BONUS stop', emoji: '🌟' },
  { id: 'wednesdays', name: '&Wednesdays Pop-up', address: '1115 U St NW, Washington, DC 20009', lat: 38.91720, lng: -77.02779, points: 10, type: 'checkpoint', perk: 'Limited-edition menu item at Cookies HQ', emoji: '🎪' },
];

function getCheckpoint(id) {
  return CHECKPOINTS.find(c => c.id === id) || null;
}

// ── Prize Wheel Prizes ──
const WHEEL_PRIZES = [
  { label: '10 Bonus Pts', emoji: '⭐', color: '#5b9dff' },
  { label: 'Cookies Sticker', emoji: '🍪', color: '#1a73e8' },
  { label: '5 Bonus Pts', emoji: '✨', color: '#3d7be8' },
  { label: 'Free Entry', emoji: '🎟️', color: '#7b5dff' },
  { label: '15 Bonus Pts', emoji: '🔥', color: '#e8a020' },
  { label: 'Drink Token', emoji: '🥤', color: '#20c870' },
  { label: 'Try Again', emoji: '🔄', color: '#5d6f97' },
  { label: 'Cookies Hat', emoji: '🧢', color: '#e85050' },
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
  const msg = '🍪 Welcome to the U Street Hunt, ' + hunterName + '! Your digital passport is live. Explore the corridor, scan at every stop, earn points & win prizes. July 11-18. Map: https://ustreet-hunt.atcheofficial.com/map.html';
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
