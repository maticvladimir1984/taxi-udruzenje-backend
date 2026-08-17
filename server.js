const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DRIVERS_FILE = path.join(DATA_DIR, 'drivers.json');
const RIDES_FILE = path.join(DATA_DIR, 'rides.json');

// ---- Storage helpers (JSON fajl na disku) ----
function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DRIVERS_FILE)) fs.writeFileSync(DRIVERS_FILE, '[]');
  if (!fs.existsSync(RIDES_FILE)) fs.writeFileSync(RIDES_FILE, '[]');
}

function loadDrivers() {
  ensureData();
  try { return JSON.parse(fs.readFileSync(DRIVERS_FILE, 'utf8')); }
  catch (e) { return []; }
}

function saveDrivers(drivers) {
  fs.writeFileSync(DRIVERS_FILE, JSON.stringify(drivers, null, 2));
}

function loadRides() {
  ensureData();
  try { return JSON.parse(fs.readFileSync(RIDES_FILE, 'utf8')); }
  catch (e) { return []; }
}

function saveRides(rides) {
  fs.writeFileSync(RIDES_FILE, JSON.stringify(rides, null, 2));
}

// ---- In-memory state (za Socket.IO održavanje veza) ----
const drivers = loadDrivers();
const rides = loadRides();

// Mapiranje socket konekcija vozača: driverId -> socket.id
const driverSockets = {};

// Default tarifa koju dispečer može konfigurisati
const SETTINGS = {
  baseFare: 200,          // RSD
  pricePerKm: 80,         // RSD
  pricePerMinute: 15,     // RSD
};

function calcFare(distanceKm, durationMin) {
  return Math.max(SETTINGS.baseFare,
    Math.round(SETTINGS.baseFare + distanceKm * SETTINGS.pricePerKm + durationMin * SETTINGS.pricePerMinute));
}

// ID generatori
function nextId(prefix, arr) {
  const max = arr.reduce((m, x) => {
    const n = parseInt(String(x.id).replace(prefix, ''), 10);
    return (!isNaN(n) && n > m) ? n : m;
  }, 0);
  return prefix + (max + 1);
}

// Geometrija: približna distanca (haversine) u km
function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Procena trajanja (min) na osnovu distance
function estimateMinutes(distanceKm) {
  return Math.max(3, Math.round((distanceKm / 25) * 60)); // ~25 km/h prosečno u gradu
}

// ETA od vozača do tačke preuzimanja
function computeEta(driverLat, driverLng, toLat, toLng) {
  const km = haversineKm({ lat: driverLat, lng: driverLng }, { lat: toLat, lng: toLng });
  const minutes = Math.max(1, Math.round((km / 25) * 60));
  return { distanceKm: Math.round(km * 10) / 10, etaMinutes: minutes };
}

// ---- REST API ----
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/settings', (req, res) => res.json(SETTINGS));
app.post('/api/settings', (req, res) => {
  Object.assign(SETTINGS, req.body);
  res.json(SETTINGS);
});

// ---- Vozači ----
app.get('/api/drivers', (req, res) => res.json(drivers));

app.post('/api/drivers', (req, res) => {
  const { name, vehicle, plate, phone } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Ime je obavezno' });
  const driver = {
    id: nextId('d', drivers),
    name,
    vehicle: vehicle || '',
    plate: plate || '',
    phone: phone || '',
    status: 'offline', // offline | available | enroute | busy
    lat: null,
    lng: null,
    createdAt: new Date().toISOString(),
  };
  drivers.push(driver);
  saveDrivers(drivers);
  io.emit('drivers:updated', drivers);
  res.json(driver);
});

app.delete('/api/drivers/:id', (req, res) => {
  const i = drivers.findIndex(d => d.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Vozač ne postoji' });
  drivers.splice(i, 1);
  saveDrivers(drivers);
  io.emit('drivers:updated', drivers);
  res.json({ ok: true });
});

// ---- Vožnje ----
app.get('/api/rides', (req, res) => res.json(rides));

app.post('/api/rides/estimate', (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'Odredište i polazak su obavezni' });
  const distanceKm = haversineKm(from, to);
  const durationMin = estimateMinutes(distanceKm);
  res.json({
    distanceKm: Math.round(distanceKm * 10) / 10,
    durationMin,
    price: calcFare(distanceKm, durationMin),
  });
});

// Kreiranje vožnje + automatsko slanje ponuda slobodnim vozačima
app.post('/api/rides', (req, res) => {
  const { passenger, from, to, distanceKm, durationMin, price, passengers } = req.body || {};
  if (!passenger || !from || !to) return res.status(400).json({ error: 'Nedostaju podaci' });

  const ride = {
    id: nextId('r', rides),
    passenger,
    passengers: passengers || 1,
    from,
    to,
    distanceKm: distanceKm || 0,
    durationMin: durationMin || 0,
    price: price || 0,
    status: 'pending', // pending | offering | accepted | arrived | started | completed | cancelled
    driverId: null,
    rejectedBy: [],       // driverId koji su odbili ponudu
    createdAt: new Date().toISOString(),
    history: [{ status: 'pending', at: new Date().toISOString() }],
  };

  rides.push(ride);
  saveRides(rides);
  io.emit('rides:updated', rides);

  // Automatski pošalji ponudu svim online i slobodnim vozačima
  const available = drivers.filter(d => d.status === 'available');
  if (available.length > 0) {
    ride.status = 'offering';
    ride.history.push({ status: 'offering', at: new Date().toISOString() });
    saveRides(rides);
    io.emit('rides:updated', rides);

    for (const d of available) {
      const socketId = driverSockets[d.id];
      if (socketId) {
        io.to(socketId).emit('ride:offer', ride);
      }
    }
    // Ponuda ističe posle 25 sekundi ako niko ne prihvati
    setTimeout(() => {
      const r = rides.find(x => x.id === ride.id);
      if (r && r.status === 'offering') {
        // Ako niko nije prihvatio, sačuvaj kao pending za ručnu dodelu
        r.status = 'pending';
        r.history.push({ status: 'pending', at: new Date().toISOString() });
        saveRides(rides);
        io.emit('rides:updated', rides);
        io.emit('ride:offers_expired', { rideId: ride.id });
      }
    }, 25000);
  }

  res.json(ride);
});

// Vozač prihvata ponudu
app.post('/api/rides/:id/accept', (req, res) => {
  const ride = rides.find(r => r.id === req.params.id);
  if (!ride) return res.status(404).json({ error: 'Vožnja ne postoji' });
  if (!['pending', 'offering'].includes(ride.status)) {
    return res.status(400).json({ error: 'Vožnja je već dodeljena' });
  }
  const driverId = req.body.driverId;
  const driver = drivers.find(d => d.id === driverId);
  if (!driver) return res.status(400).json({ error: 'Vozač ne postoji' });
  if (driver.status !== 'available') {
    return res.status(400).json({ error: 'Vozač nije dostupan' });
  }

  ride.driverId = driverId;
  ride.status = 'accepted';
  ride.history.push({ status: 'accepted', at: new Date().toISOString() });
  driver.status = 'enroute'; // vozač je krenuo ka korisniku
  saveRides(rides);
  saveDrivers(drivers);

  io.emit('rides:updated', rides);
  io.emit('drivers:updated', drivers);
  io.emit('ride:status', { rideId: ride.id, status: 'accepted', driverId });

  // Pošalji korisniku ETA vozača
  if (driver.lat != null && driver.lng != null && ride.from) {
    const eta = computeEta(driver.lat, driver.lng, ride.from.lat, ride.from.lng);
    io.emit('ride:eta', { rideId: ride.id, etaMinutes: eta.etaMinutes, distanceKm: eta.distanceKm });
  }

  // Obavesti ostale vozače da je ponuda istekla
  for (const d of drivers) {
    if (d.id !== driverId && driverSockets[d.id]) {
      io.to(driverSockets[d.id]).emit('ride:offer_expired', { rideId: ride.id });
    }
  }
  res.json(ride);
});

// Vozač odbija ponudu
app.post('/api/rides/:id/reject', (req, res) => {
  const ride = rides.find(r => r.id === req.params.id);
  if (!ride) return res.status(404).json({ error: 'Vožnja ne postoji' });
  const driverId = req.body.driverId;
  if (!ride.rejectedBy.includes(driverId)) {
    ride.rejectedBy.push(driverId);
  }
  saveRides(rides);
  res.json(ride);
});

// Ručna dodela od strane dispečera (fallback)
app.post('/api/rides/:id/assign', (req, res) => {
  const ride = rides.find(r => r.id === req.params.id);
  if (!ride) return res.status(404).json({ error: 'Vožnja ne postoji' });
  const driverId = req.body.driverId;
  const driver = drivers.find(d => d.id === driverId);
  if (!driver) return res.status(400).json({ error: 'Vozač ne postoji' });
  if (!['available', 'offline'].includes(driver.status)) {
    return res.status(400).json({ error: 'Vozač nije slobodan' });
  }

  ride.driverId = driverId;
  ride.status = 'accepted';
  ride.history.push({ status: 'accepted', at: new Date().toISOString() });
  driver.status = 'enroute';
  saveRides(rides);
  saveDrivers(drivers);

  io.emit('rides:updated', rides);
  io.emit('drivers:updated', drivers);
  io.emit('ride:status', { rideId: ride.id, status: 'accepted', driverId });
  res.json(ride);
});

// Promena statusa vožnje (arrived / started / completed / cancelled)
app.post('/api/rides/:id/status', (req, res) => {
  const ride = rides.find(r => r.id === req.params.id);
  if (!ride) return res.status(404).json({ error: 'Vožnja ne postoji' });
  const status = req.body.status;
  const valid = ['arrived', 'started', 'completed', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Nepoznat status' });

  ride.status = status;
  ride.history.push({ status, at: new Date().toISOString() });

  const driver = drivers.find(d => d.id === ride.driverId);
  if (driver) {
    if (status === 'completed' || status === 'cancelled') {
      driver.status = 'available'; // oslobodi vozilo
    } else if (status === 'arrived') {
      driver.status = 'busy'; // stigao na mesto preuzimanja
    } else if (status === 'started') {
      driver.status = 'busy'; // vožnja u toku
    }
  }

  saveRides(rides);
  saveDrivers(drivers);
  io.emit('rides:updated', rides);
  io.emit('drivers:updated', drivers);
  io.emit('ride:status', { rideId: ride.id, status });
  res.json(ride);
});

// ---- Socket.IO za real-time ----
io.on('connection', (socket) => {
  socket.emit('init', { drivers, rides, settings: SETTINGS });

  // Vozač se registruje (veza između driverId i socket-a)
  socket.on('driver:register', (data) => {
    if (data && data.driverId) {
      driverSockets[data.driverId] = socket.id;
    }
  });

  socket.on('driver:online', (data) => {
    const driver = drivers.find(d => d.id === data.driverId);
    if (driver) {
      driver.status = 'available';
      driver.lat = data.lat;
      driver.lng = data.lng;
      saveDrivers(drivers);
      io.emit('drivers:updated', drivers);
    }
  });

  socket.on('driver:offline', (data) => {
    const driver = drivers.find(d => d.id === data.driverId);
    if (driver) {
      driver.status = 'offline';
      saveDrivers(drivers);
      io.emit('drivers:updated', drivers);
    }
  });

  socket.on('driver:location', (data) => {
    const driver = drivers.find(d => d.id === data.driverId);
    if (driver) {
      driver.lat = data.lat;
      driver.lng = data.lng;
      if (driver.status === 'offline') driver.status = 'available';
      saveDrivers(drivers);
      io.emit('drivers:updated', drivers);

      // Ako vozi ka korisniku, osveži ETA
      const ride = rides.find(r => r.driverId === driver.id && r.status === 'accepted');
      if (ride && ride.from) {
        const eta = computeEta(driver.lat, driver.lng, ride.from.lat, ride.from.lng);
        io.emit('ride:eta', { rideId: ride.id, etaMinutes: eta.etaMinutes, distanceKm: eta.distanceKm });
      }
    }
  });

  socket.on('disconnect', () => {
    for (const [driverId, sockId] of Object.entries(driverSockets)) {
      if (sockId === socket.id) {
        delete driverSockets[driverId];
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Taksi udruženje server pokrenut na http://localhost:${PORT}`);
  console.log(`   Dispečer panel:  http://localhost:${PORT}/dispecer.html`);
  console.log(`   Vozač:           http://localhost:${PORT}/vozac.html`);
  console.log(`   Korisnik:        http://localhost:${PORT}/korisnik.html`);
});