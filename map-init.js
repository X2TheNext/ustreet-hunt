// Map initialization
if (typeof L === 'undefined') {
  document.getElementById('map').innerHTML = '<div style="padding:40px;text-align:center;color:#8ea3cf;">Loading map...</div>';
}

var map = L.map('map', { zoomControl: true, attributionControl: false }).setView([38.9171, -77.0300], 15);

// Reliable OpenStreetMap tiles
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19
}).addTo(map);

// Location button
var lc = L.control({ position: 'bottomright' });
lc.onAdd = function() {
  var b = L.DomUtil.create('button', '');
  b.innerHTML = '📍'; b.title = 'My location';
  b.style.cssText = 'width:42px;height:42px;border-radius:12px;background:rgba(10,28,65,.92);border:1px solid rgba(91,157,255,.2);color:#fff;font-size:18px;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.4);';
  b.onclick = function(e) { e.preventDefault(); map.locate({ setView: true, maxZoom: 17 }); };
  return b;
};
lc.addmap);

// Fit-all button
var fc = L.control({ position: 'bottomright' });
fc.onAdd = function() {
  var b = L.DomUtil.create('button', '');
  b.innerHTML = '🔲'; b.title = 'Show all';
  b.style.cssText = 'width:42px;height:42px;border-radius:12px;backgrnd:rgba(10,28,65,.92);border:1px solid rgba(91,157,255,.2);color:#fff;font-size:18px;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.4);margin-bottom:8px;';
  b.onclick = function(e) {
    e.preventDefault();
    var bounds = [];
    if (typeof CHECKPOINTS !== 'undefined') {
      for (var i = 0; i < CHECKPOINTS.length; i++) bounds.push([CHECKPOINTS[i].lat, CHECKPOINTS[i].lng]);
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [30,30], maxZoom: 16 });
  };
  return b;
};
fc.addTo(map);

// Build markers
if (typeof CHECKPOINTS !== 'undefined' && CHECKPOINTS.length) {
  var drawer = document.getElementById('drawer');
  var allBounds = [];
  for (var i = 0; i < CHECKPOINTS.length; i++) {
    (function() {
      var cp = CHECKPOINTS[i];
      allBounds.push([cp.lat, cp.lng]);
      var earned = typeof userStamps !== 'undefined' && userStamps.indexOf(cp.id) >= 0;
      var cls = 'custom-marker';
      if (cp.type === 'hq') cls += ' hq';
      if (cp.type === 'bonus') cls += ' bonus';
      if (earned) cls += ' collected';

      var icon = L.divIcon({
        className: cls,
        html: earned ? '✓' : (cp.points > 0 ? String(cp.points) : cp.emoji),
      iconSize: [40,40], iconAnchor: [20,20], popupAnchor: [0,-22]
      });

      var popup = '<div style="text-align:center;min-width:140px;padding:4px 0;">';
      popup += '<div style="font-size:28px;">' + cp.emoji + '</div>';
      popup += '<div style="font-weight:800;font-size:14px;margin-top:4px;">' + cp.name + '</div>';
      popup += '<div style="font-size:10px;color:#8ea3cf;margin-top:2px;">' + (cp.address||'') + '</div>';
      popup += '<div style="font-size:11px;color:#8ea3cf;margin-top:3px;">' + cp.perk + '</div>';
      popup += '<div style="font-weight:700;color:#5b9dff;margin-top:5px;">' + (cp.points>0?'+' + cp.points + ' pts':'HQ') + (earned?' ✓ Done':'') + '</div>';
      popup += '<a href="checkpoint.html?id=' +p.id + '" style="color:#5b9dff;font-size:11px;font-weight:700;">Details →</a></div>';

      var m = L.marker([cp.lat, cp.lng], { icon: icon }).addTo(map);
      m.bindPopup(popup);

      m.on('click', (function(cp2, rned2) {
        return function() {
          if (!drawer) return;
          drawer.classList.add('active');
          document.getElementById('drawer-emoji').textContent = cp2.emoji;
          document.getElementById('drawer-name').textContent = cp2.name;
          var a = document.getElementById('drawer-address'); if (a) a.textContent = cp2.address || '';
          document.getElementById('drawer-perk').textContent = cp2.perk;
          document.getElementById('drawer-pts').textContent = cp2.points > 0 ? '+' + cp2.points : 'HQ';
          document.getElementById('drawer-link').href = 'checkpoint.html?id=' + cp2.id;
          var badge = document.getElementById('drawer-badge');
          if (badge) badge.innerHTML = earned2 ? '<span class="badge badge-gold">✓ Collected</span>' : '<span class="badge badge-blue">Not stamped</span>';
          document.getElementById('drawer-sn').onclick = async function() {
            if (typeof isLoggedIn !== 'function' || !isLoggedIn()) { window.location.href = 'register.html'; return; }
            if (earned2) { return; }
            if (typeof earnStamp === 'function') {
              var r = await earnStamp(cp2.id, cp2.name, cp2.points);
              if (r && r.error) return;
              if (typeof launchConfetti === 'function') launchConfetti();
              setTimeout(function() { location.reload(); }, 800);
            }
          };
        };
      })(cp, earned));
    })();
  }
  setTimeout(function() {
    if (allBounds.length) map.fitBounds(allBounds, { padding: [30,30], maxZoom: 16 });
  }, 500);
}

// User location
map.on('locationfound', function(e) {
  L.circle(e.latlng, { radius: e.accuracy/2, fillColor: '#5b9dff', fillOpacity: .08, color: 'transparent', weight: 0 }).addTo(map);
  var pi = L.divIcon({ className: 'user-pulse', iconSize: [18,18], iconAnchor: [9,9] });
  L.marker(e.latlng, { icon: pi, zIndexOffset: 999 }).addTo(map).bindPopup('<b>📍 You are here</b>', { offset: [0,-12] });
});
map.on('locationerror', function() { console.log('Location unavaible'); });
setTimeout(function() { map.locate({ setView: false, maxZoom: 17 }); }, 2000);
