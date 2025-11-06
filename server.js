import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Инициализация Express
const app = express();
const httpServer = createServer(app);

// Настройка CORS
const allowedOrigins = [
    'https://manager-battle-tg.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
    'https://manager-battle-tg-git-main-alekss-projects-6ce0c7ca.vercel.app',
    'https://manager-battle-tg-alekss-projects-6ce0c7ca.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        // Разрешаем запросы без origin (мобильные приложения, Postman, etc.)
        if (!origin) return callback(null, true);
        
        // Разрешаем если начинается с допустимых доменов
        if (origin.includes('vercel.app') || 
            origin.includes('localhost') ||
            allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(null, true); // Временно разрешаем все для отладки
        }
    },
    credentials: true
}));

app.use(express.json());

// Инициализация Socket.IO
const io = new Server(httpServer, {
    cors: {
        origin: function (origin, callback) {
            // Разрешаем всё для отладки
            callback(null, true);
        },
        methods: ['GET', 'POST'],
        credentials: true,
        allowedHeaders: ['Content-Type']
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

// Инициализация базы данных
// Используем путь который сохраняется на Railway
const dbPath = process.env.DATABASE_PATH || './data/game.db';

// Создаём директорию если её нет
import { mkdirSync, existsSync } from 'fs';
const dbDir = dbPath.substring(0, dbPath.lastIndexOf('/'));
if (dbDir && !existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
console.log(`💾 База данных: ${dbPath}`);

// Создание таблиц
db.exec(`
    CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'waiting',
        settings TEXT,
        current_level INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER,
        name TEXT,
        score INTEGER DEFAULT 100,
        level1_data TEXT,
        level2_data TEXT,
        level3_data TEXT,
        FOREIGN KEY (game_id) REFERENCES games(id)
    );

    CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id INTEGER,
        team_id INTEGER,
        name TEXT,
        role TEXT,
        telegram_id TEXT,
        socket_id TEXT,
        FOREIGN KEY (game_id) REFERENCES games(id),
        FOREIGN KEY (team_id) REFERENCES teams(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id INTEGER,
        player_name TEXT,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_id) REFERENCES teams(id)
    );
`);

console.log('✅ База данных инициализирована');

// Хранилище активных игр в памяти
const activeGames = new Map();

// ============================================
// API ENDPOINTS
// ============================================

// Главная страница
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Manager Battle Backend',
        version: '1.0.0'
    });
});

// Создание новой игры
app.post('/api/game/create', (req, res) => {
    const { settings } = req.body;
    const code = generateGameCode();
    
    try {
        const stmt = db.prepare('INSERT INTO games (code, settings) VALUES (?, ?)');
        const result = stmt.run(code, JSON.stringify(settings));
        const gameId = result.lastInsertRowid;
        
        // Создаём команды
        const teamNames = ['Альфа', 'Бета', 'Гамма', 'Дельта', 'Эпсилон', 'Сигма'];
        const teamStmt = db.prepare('INSERT INTO teams (game_id, name) VALUES (?, ?)');
        
        for (let i = 0; i < settings.teamCount; i++) {
            teamStmt.run(gameId, `Команда ${teamNames[i]}`);
        }
        
        // Инициализируем игру в памяти
        activeGames.set(code, {
            id: gameId,
            code,
            status: 'waiting',
            settings,
            currentLevel: 0,
            players: [],
            teams: []
        });
        
        res.json({
            success: true,
            code,
            gameId
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Получение информации об игре
app.get('/api/game/:code', (req, res) => {
    const { code } = req.params;
    
    try {
        const game = db.prepare('SELECT * FROM games WHERE code = ?').get(code);
        
        if (!game) {
            return res.status(404).json({
                success: false,
                error: 'Game not found'
            });
        }
        
        const teams = db.prepare('SELECT * FROM teams WHERE game_id = ?').all(game.id);
        const players = db.prepare('SELECT * FROM players WHERE game_id = ?').all(game.id);
        
        res.json({
            success: true,
            game: {
                ...game,
                settings: JSON.parse(game.settings),
                teams: teams.map(t => ({
                    ...t,
                    level1_data: t.level1_data ? JSON.parse(t.level1_data) : null,
                    level2_data: t.level2_data ? JSON.parse(t.level2_data) : null,
                    level3_data: t.level3_data ? JSON.parse(t.level3_data) : null
                })),
                players
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Обновление счёта команды
app.post('/api/game/:code/score', (req, res) => {
    const { code } = req.params;
    const { teamId, points } = req.body;
    
    try {
        const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
        const newScore = team.score + points;
        
        db.prepare('UPDATE teams SET score = ? WHERE id = ?').run(newScore, teamId);
        
        // Уведомляем всех игроков
        io.to(code).emit('score-updated', {
            teamId,
            score: newScore,
            change: points
        });
        
        res.json({
            success: true,
            newScore
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Начало игры
app.post('/api/game/:code/start', (req, res) => {
    const { code } = req.params;
    
    try {
        db.prepare('UPDATE games SET status = ?, current_level = 1 WHERE code = ?').run('playing', code);
        
        // Уведомляем всех игроков
        io.to(code).emit('game-started', { level: 1 });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Переход на следующий уровень
app.post('/api/game/:code/next-level', (req, res) => {
    const { code } = req.params;
    
    try {
        const game = db.prepare('SELECT * FROM games WHERE code = ?').get(code);
        const nextLevel = game.current_level + 1;
        
        db.prepare('UPDATE games SET current_level = ? WHERE code = ?').run(nextLevel, code);
        
        // Уведомляем всех игроков
        io.to(code).emit('level-changed', { level: nextLevel });
        
        res.json({ success: true, level: nextLevel });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Сохранение данных уровня
app.post('/api/game/:code/level-data', (req, res) => {
    const { code } = req.params;
    const { teamId, level, data } = req.body;
    
    try {
        const column = `level${level}_data`;
        const stmt = db.prepare(`UPDATE teams SET ${column} = ? WHERE id = ?`);
        stmt.run(JSON.stringify(data), teamId);
        
        // Уведомляем команду
        io.to(`team-${teamId}`).emit('level-data-saved', { level, data });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// SOCKET.IO EVENTS
// ============================================

io.on('connection', (socket) => {
    console.log('🔌 Новое подключение:', socket.id);
    console.log('   Origin:', socket.handshake.headers.origin);
    console.log('   Transport:', socket.conn.transport.name);
    
    // Присоединение к игре
    socket.on('join-game', async (data) => {
        console.log('📥 join-game:', data);
        const { code, playerName, teamId, role } = data;
        
        try {
            const game = db.prepare('SELECT * FROM games WHERE code = ?').get(code);
            
            if (!game) {
                socket.emit('error', { message: 'Игра не найдена' });
                return;
            }
            
            // Сохраняем игрока
            const stmt = db.prepare('INSERT INTO players (game_id, team_id, name, role, socket_id) VALUES (?, ?, ?, ?, ?)');
            stmt.run(game.id, teamId, playerName, role, socket.id);
            
            // Присоединяемся к комнате игры
            socket.join(code);
            socket.join(`team-${teamId}`);
            
            // Отправляем данные игры
            const teams = db.prepare('SELECT * FROM teams WHERE game_id = ?').all(game.id);
            const players = db.prepare('SELECT * FROM players WHERE game_id = ?').all(game.id);
            
            socket.emit('game-joined', {
                game: {
                    ...game,
                    settings: JSON.parse(game.settings)
                },
                teams,
                players
            });
            
            // Уведомляем всех о новом игроке
            io.to(code).emit('player-joined', {
                name: playerName,
                teamId,
                role
            });
            
            console.log(`✅ ${playerName} присоединился к игре ${code}`);
        } catch (error) {
            console.error('Ошибка при присоединении:', error);
            socket.emit('error', { message: error.message });
        }
    });
    
    // Отправка сообщения в чат команды
    socket.on('send-message', (data) => {
        const { teamId, playerName, message } = data;
        
        // Сохраняем в БД
        db.prepare('INSERT INTO messages (team_id, player_name, message) VALUES (?, ?, ?)').run(teamId, playerName, message);
        
        // Отправляем команде
        io.to(`team-${teamId}`).emit('new-message', {
            playerName,
            message,
            timestamp: new Date().toISOString()
        });
    });
    
    // Обновление счёта
    socket.on('update-score', (data) => {
        const { teamId, points } = data;
        
        try {
            const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
            const newScore = team.score + points;
            
            db.prepare('UPDATE teams SET score = ? WHERE id = ?').run(newScore, teamId);
            
            // Уведомляем всех
            io.emit('score-updated', {
                teamId,
                score: newScore,
                change: points
            });
        } catch (error) {
            console.error('Ошибка обновления счёта:', error);
        }
    });
    
    // Отключение
    socket.on('disconnect', (reason) => {
        console.log('🔌 Отключение:', socket.id, 'Причина:', reason);
        
        // Удаляем игрока из БД
        db.prepare('DELETE FROM players WHERE socket_id = ?').run(socket.id);
    });
    
    // Обработка ошибок
    socket.on('error', (error) => {
        console.error('❌ Ошибка Socket:', socket.id, error);
    });
    
    socket.on('connect_error', (error) => {
        console.error('❌ Ошибка подключения:', error);
    });
});

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function generateGameCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// ============================================
// ЗАПУСК СЕРВЕРА
// ============================================

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║   🚀 BACKEND ЗАПУЩЕН!                      ║
║                                            ║
║   📡 Сервер: http://localhost:${PORT}       ║
║   🔌 WebSocket: готов                      ║
║   💾 База данных: подключена               ║
║                                            ║
╚════════════════════════════════════════════╝
    `);
});
