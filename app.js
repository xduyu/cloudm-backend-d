import express from 'express';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import multer from 'multer';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE   = path.join(__dirname, 'app.db');
const UPLOADS_DIR = path.join(__dirname, 'uploads/tracks');
const COVERS_DIR  = path.join(__dirname, 'uploads/covers');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(COVERS_DIR))  fs.mkdirSync(COVERS_DIR,  { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username          TEXT PRIMARY KEY,
    password          TEXT NOT NULL,
    email             TEXT NOT NULL UNIQUE,
    profile_picture   TEXT,
    is_artist         INTEGER NOT NULL DEFAULT 0,
    is_admin          INTEGER NOT NULL DEFAULT 0,
    is_mod            INTEGER NOT NULL DEFAULT 0,
    is_banned         INTEGER NOT NULL DEFAULT 0,
    subscription_type TEXT NOT NULL DEFAULT 'free'
  );

  CREATE TABLE IF NOT EXISTS subscribed_artists (
    username        TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    artist_username TEXT NOT NULL,
    PRIMARY KEY (username, artist_username)
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    artist          TEXT NOT NULL,
    album           TEXT NOT NULL,
    duration        TEXT,
    added_by        TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    plays           INTEGER NOT NULL DEFAULT 0,
    filename        TEXT NOT NULL,
    url             TEXT NOT NULL,
    cover_filename  TEXT,
    cover_url       TEXT
  );

  CREATE TABLE IF NOT EXISTS favourite_tracks (
    username  TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    track_id  TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    PRIMARY KEY (username, track_id)
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    name     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS albums (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    name     TEXT NOT NULL
  );
`);

const stmts = {
  findUserByUsername:  db.prepare('SELECT * FROM users WHERE username = ?'),
  findUserByCredentials: db.prepare('SELECT * FROM users WHERE username = ? AND password = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (username, password, email, profile_picture,
                       is_artist, is_admin, is_mod, is_banned, subscription_type)
    VALUES (@username, @password, @email, @profile_picture,
            @is_artist, @is_admin, @is_mod, @is_banned, @subscription_type)
  `),
  allUsers: db.prepare('SELECT * FROM users'),
  updateUser: db.prepare(`
    UPDATE users SET
      is_artist         = COALESCE(@is_artist, is_artist),
      is_admin          = COALESCE(@is_admin,  is_admin),
      is_mod            = COALESCE(@is_mod,    is_mod),
      subscription_type = COALESCE(@subscription_type, subscription_type),
      profile_picture   = COALESCE(@profile_picture, profile_picture)
    WHERE username = @username
  `),
  deleteUser: db.prepare('DELETE FROM users WHERE username = ?'),
  setBanned:  db.prepare('UPDATE users SET is_banned = @is_banned WHERE username = @username'),

  allTracks:        db.prepare('SELECT * FROM tracks'),
  tracksByArtist:   db.prepare('SELECT * FROM tracks WHERE added_by = ?'),
  findTrack:        db.prepare('SELECT * FROM tracks WHERE id = ?'),
  insertTrack:      db.prepare(`
    INSERT INTO tracks (id, title, artist, album, duration, added_by, plays,
                        filename, url, cover_filename, cover_url)
    VALUES (@id, @title, @artist, @album, @duration, @added_by, @plays,
            @filename, @url, @cover_filename, @cover_url)
  `),
  updateTrack: db.prepare(`
    UPDATE tracks SET title = @title, artist = @artist, album = @album,
                      duration = @duration, cover_filename = @cover_filename,
                      cover_url = @cover_url
    WHERE id = @id
  `),
  deleteTrack: db.prepare('DELETE FROM tracks WHERE id = ?'),

  isFavourite:       db.prepare('SELECT 1 FROM favourite_tracks WHERE username = ? AND track_id = ?'),
  addFavourite:      db.prepare('INSERT INTO favourite_tracks (username, track_id) VALUES (?, ?)'),
  removeFavourite:   db.prepare('DELETE FROM favourite_tracks WHERE username = ? AND track_id = ?'),
  userFavourites:    db.prepare('SELECT track_id FROM favourite_tracks WHERE username = ?'),
};

function rowToUser(row) {
  if (!row) return null;
  const { password, ...rest } = row;
  return {
    username:         rest.username,
    email:            rest.email,
    profilePicture:   rest.profile_picture,
    isArtist:         Boolean(rest.is_artist),
    isAdmin:          Boolean(rest.is_admin),
    isMod:            Boolean(rest.is_mod),
    isBanned:         Boolean(rest.is_banned),
    SubScribtionType: rest.subscription_type,
    FavouriteTracks:  stmts.userFavourites.all(rest.username).map(r => r.track_id),
  };
}

function rowToTrack(row) {
  if (!row) return null;
  return {
    id:            row.id,
    title:         row.title,
    artist:        row.artist,
    album:         row.album,
    duration:      row.duration,
    addedBy:       row.added_by,
    plays:         row.plays,
    filename:      row.filename,
    url:           row.url,
    coverFilename: row.cover_filename,
    coverUrl:      row.cover_url,
  };
}


const app  = express();
const PORT = process.env.PORT || 4000;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'secret-key';

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


const coverStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, file.fieldname === 'cover' ? COVERS_DIR : UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const uploadFields = multer({
  storage: coverStorage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.jpg', '.jpeg', '.png', '.webp', '.gif'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase()))
      cb(null, true);
    else
      cb(new Error('Недопустимый формат файла'));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
}).fields([
  { name: 'file',  maxCount: 1 },
  { name: 'cover', maxCount: 1 },
]);


function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, TOKEN_SECRET, (err, decoded) => {
    if (err) return res.sendStatus(403);
    req.user = decoded;
    next();
  });
}

function requireMod(req, res, next) {
  const row = stmts.findUserByUsername.get(req.user.user.username);
  if (!row) return res.status(404).json({ message: 'User not found' });
  if (!row.is_admin && !row.is_mod) return res.status(403).json({ message: 'Forbidden' });
  req.dbUser = row;
  next();
}

function requireAdmin(req, res, next) {
  const row = stmts.findUserByUsername.get(req.user.user.username);
  if (!row) return res.status(404).json({ message: 'User not found' });
  if (!row.is_admin) return res.status(403).json({ message: 'Forbidden' });
  req.dbUser = row;
  next();
}


app.get('/', (req, res) => res.json({ message: 'API is running' }));

app.post('/api/auth/register', (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password || !email)
    return res.status(400).json({ message: 'All fields required' });

  if (stmts.findUserByUsername.get(username))
    return res.status(400).json({ message: 'Username already exists' });

  try {
    stmts.insertUser.run({
      username, password, email,
      profile_picture: null,
      is_artist: 0, is_admin: 0, is_mod: 0, is_banned: 0,
      subscription_type: 'free',
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(400).json({ message: 'Email already exists' });
    throw err;
  }

  res.status(201).json({ message: 'Пользователь зарегистрирован',
                          user: rowToUser(stmts.findUserByUsername.get(username)) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: 'All fields required' });

  const row = stmts.findUserByCredentials.get(username, password);
  if (!row) return res.status(401).json({ message: 'Invalid username or password' });

  const payload = rowToUser(row);
  const token = jwt.sign({ user: payload }, TOKEN_SECRET, { expiresIn: '31d' });
  res.json({ message: 'Login successful', token, user: payload });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  const row = stmts.findUserByUsername.get(req.user.user.username);
  if (!row) return res.status(404).json({ message: 'User not found' });
  res.json({ user: rowToUser(row) });
});

app.post('/api/tracks', authenticateToken, uploadFields, (req, res) => {
  const { title, artist, album, duration } = req.body;
  if (!title || !artist || !album)
    return res.status(400).json({ message: 'title, artist, album обязательны' });

  const audioFile = req.files?.['file']?.[0];
  const coverFile = req.files?.['cover']?.[0];
  if (!audioFile) return res.status(400).json({ message: 'Аудио файл обязателен' });

  const id = Date.now().toString();
  const track = {
    id, title, artist, album,
    duration:       duration || null,
    added_by:       req.user.user.username,
    plays:          0,
    filename:       audioFile.filename,
    url:            `http://localhost:${PORT}/uploads/tracks/${audioFile.filename}`,
    cover_filename: coverFile?.filename || null,
    cover_url:      coverFile
      ? `http://localhost:${PORT}/uploads/covers/${coverFile.filename}`
      : null,
  };

  stmts.insertTrack.run(track);
  res.status(201).json({ message: 'Трек сохранён', track: rowToTrack(stmts.findTrack.get(id)) });
});

app.post('/api/tracks/add-favorite/:id', authenticateToken, (req, res) => {
  const trackId = req.params.id;
  if (!stmts.findTrack.get(trackId))
    return res.status(404).json({ message: 'Track not found' });

  const username = req.user.user.username;
  if (!stmts.findUserByUsername.get(username))
    return res.status(404).json({ message: 'User not found' });

  if (stmts.isFavourite.get(username, trackId)) {
    stmts.removeFavourite.run(username, trackId);
    return res.json({ message: 'Removed from favorites', liked: false });
  }
  stmts.addFavourite.run(username, trackId);
  res.json({ message: 'Added to favorites', liked: true });
});

app.get('/api/tracks', authenticateToken, (req, res) => {
  const row  = stmts.findUserByUsername.get(req.user.user.username);
  if (!row) return res.status(404).json({ message: 'User not found' });

  const all = stmts.allTracks.all().map(rowToTrack);
  if (row.is_admin || row.is_mod) return res.json({ tracks: all });
  if (row.is_artist) return res.json({ tracks: all.filter(t => t.addedBy === row.username) });
  res.json({ tracks: all });
});

app.delete('/api/tracks/:id', authenticateToken, (req, res) => {
  const { user } = req.user;
  const row = stmts.findTrack.get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Track not found' });

  if (!user.isAdmin && !user.isMod && row.added_by !== user.username)
    return res.status(403).json({ message: 'Forbidden' });

  const filePath = path.join(UPLOADS_DIR, row.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  stmts.deleteTrack.run(req.params.id);
  res.json({ message: 'Track deleted' });
});

app.put('/api/tracks/:id', authenticateToken, uploadFields, (req, res) => {
  const { user } = req.user;
  const row = stmts.findTrack.get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Track not found' });

  if (!user.isAdmin && !user.isMod && row.added_by !== user.username)
    return res.status(403).json({ message: 'Forbidden' });

  const { title, artist, album, duration } = req.body;
  const coverFile = req.files?.['cover']?.[0];

  if (coverFile && row.cover_filename) {
    const oldPath = path.join(COVERS_DIR, row.cover_filename);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  stmts.updateTrack.run({
    id: req.params.id, title, artist, album, duration,
    cover_filename: coverFile?.filename ?? row.cover_filename,
    cover_url: coverFile
      ? `http://localhost:${PORT}/uploads/covers/${coverFile.filename}`
      : row.cover_url,
  });

  res.json({ message: 'Track updated', track: rowToTrack(stmts.findTrack.get(req.params.id)) });
});
app.get('/api/artists/:name', (req, res) => {
  const row = db.prepare(
    "SELECT * FROM users WHERE is_artist = 1 AND LOWER(username) = LOWER(?)"
  ).get(req.params.name);
  if (!row) return res.status(404).json({ message: 'Artist not found' });
  res.json({ artist: rowToUser(row) });
});

app.get('/api/artists/:name/tracks', (req, res) => {
  const row = db.prepare(
    "SELECT * FROM users WHERE is_artist = 1 AND LOWER(username) = LOWER(?)"
  ).get(req.params.name);
  if (!row) return res.status(404).json({ message: 'Artist not found' });
  res.json({ tracks: stmts.tracksByArtist.all(row.username).map(rowToTrack) });
});

app.get('/api/admin/users', authenticateToken, requireMod, (req, res) => {
  res.json({ users: stmts.allUsers.all().map(rowToUser) });
});

app.get('/api/admin/users/:username', authenticateToken, requireMod, (req, res) => {
  const row = stmts.findUserByUsername.get(req.params.username);
  if (!row) return res.status(404).json({ message: 'User not found' });
  res.json({ user: rowToUser(row) });
});

app.patch('/api/admin/users/:username', authenticateToken, requireAdmin, (req, res) => {
  if (!stmts.findUserByUsername.get(req.params.username))
    return res.status(404).json({ message: 'User not found' });

  const { isArtist, isAdmin, isMod, SubScribtionType, profilePicture } = req.body;
  stmts.updateUser.run({
    username: req.params.username,
    is_artist: isArtist != null ? (isArtist ? 1 : 0) : null,
    is_admin: isAdmin != null ? (isAdmin ? 1 : 0) : null,
    is_mod: isMod != null ? (isMod ? 1 : 0) : null,
    subscription_type: SubScribtionType ?? null,
    profile_picture: profilePicture ?? null,
  });

  res.json({ message: 'User updated',
  user: rowToUser(stmts.findUserByUsername.get(req.params.username)) });
});

app.delete('/api/admin/users/:username', authenticateToken, requireAdmin, (req, res) => {
  const row = stmts.findUserByUsername.get(req.params.username);
  if (!row) return res.status(404).json({ message: 'User not found' });
  if (row.username === req.dbUser.username)
    return res.status(400).json({ message: 'Cannot delete yourself' });

  stmts.deleteUser.run(req.params.username);
  res.json({ message: 'User deleted' });
});


app.get('/api/admin/tracks', authenticateToken, requireMod, (req, res) => {
  res.json({ tracks: stmts.allTracks.all().map(rowToTrack) });
});

app.delete('/api/admin/tracks/:id', authenticateToken, requireMod, (req, res) => {
  const row = stmts.findTrack.get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Track not found' });

  const filePath = path.join(UPLOADS_DIR, row.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  stmts.deleteTrack.run(req.params.id);
  res.json({ message: 'Track deleted' });
});

app.put('/api/admin/tracks/:id', authenticateToken, requireMod, (req, res) => {
  const row = stmts.findTrack.get(req.params.id);
  if (!row) return res.status(404).json({ message: 'Track not found' });

  const { title, artist, album, duration } = req.body;
  stmts.updateTrack.run({
    id: req.params.id, title, artist, album, duration,
    cover_filename: row.cover_filename,
    cover_url:      row.cover_url,
  });

  res.json({ message: 'Track updated', track: rowToTrack(stmts.findTrack.get(req.params.id)) });
});

app.get('/api/admin/stats', authenticateToken, requireMod, (req, res) => {
  const { total_users } = db.prepare('SELECT COUNT(*) AS total_users   FROM users').get();
  const { total_tracks } = db.prepare('SELECT COUNT(*) AS total_tracks  FROM tracks').get();
  const { total_artists } = db.prepare('SELECT COUNT(*) AS total_artists FROM users WHERE is_artist = 1').get();
  const { total_admins } = db.prepare('SELECT COUNT(*) AS total_admins  FROM users WHERE is_admin  = 1').get();
  const { total_mods } = db.prepare('SELECT COUNT(*) AS total_mods    FROM users WHERE is_mod    = 1').get();
  const { total_plays } = db.prepare('SELECT COALESCE(SUM(plays), 0) AS total_plays FROM tracks').get();

  const subCounts = db.prepare(
    "SELECT subscription_type, COUNT(*) AS cnt FROM users GROUP BY subscription_type"
  ).all().reduce((acc, r) => ({ ...acc, [r.subscription_type]: r.cnt }), {});

  res.json({
    totalUsers: total_users, totalTracks: total_tracks,
    totalArtists: total_artists, totalAdmins: total_admins, totalMods: total_mods,
    subscriptions: {
      free:     subCounts.free     || 0,
      premium:  subCounts.premium  || 0,
      platinum: subCounts.platinum || 0,
    },
    totalPlays: total_plays,
  });
});

app.patch('/api/admin/ban', authenticateToken, requireMod, (req, res) => {
  const { username, banned } = req.body;
  if (!username) return res.status(400).json({ message: 'Username is required' });

  const row = stmts.findUserByUsername.get(username);
  if (!row) return res.status(404).json({ message: 'User not found' });

  if (row.username === req.dbUser.username)
    return res.status(400).json({ message: 'Cannot ban yourself' });
  if (row.is_admin && !req.dbUser.is_admin)
    return res.status(403).json({ message: 'Mods cannot ban admins' });

  const newBanned = banned != null ? (banned ? 1 : 0) : (row.is_banned ? 0 : 1);
  stmts.setBanned.run({ is_banned: newBanned, username });

  const updated = rowToUser(stmts.findUserByUsername.get(username));
  res.json({ message: updated.isBanned ? 'User banned' : 'User unbanned', user: updated });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));