const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const rooms = new Map();

function genId() { return Math.random().toString(36).substr(2, 8); }

// Проверка на возможность собрать тройку
function canAnyTeamFormLine(board, blocked, boardSize) {
    const teams = ['X','O','T'];
    const dirs = [[1,0],[0,1],[1,1],[1,-1]];
    for (let team of teams) {
        for (let y = 0; y < boardSize; y++) {
            for (let x = 0; x < boardSize; x++) {
                if (board[y][x] !== null && board[y][x] !== team) continue;
                if (blocked[`${x},${y}`]) continue;
                for (let [dx,dy] of dirs) {
                    let count = 0, empty = 0;
                    for (let i = 0; i < 3; i++) {
                        const nx = x + i*dx, ny = y + i*dy;
                        if (nx<0||nx>=boardSize||ny<0||ny>=boardSize) break;
                        if (blocked[`${nx},${ny}`]) break;
                        const cell = board[ny][nx];
                        if (cell === team) count++;
                        else if (cell === null) empty++;
                        else break;
                    }
                    if (count + empty === 3) return true;
                }
            }
        }
    }
    return false;
}

function checkLines(board, blocked, boardSize) {
    const lines = [];
    const dirs = [[1,0],[0,1],[1,1],[1,-1]];
    for(let y=0;y<boardSize;y++) for(let x=0;x<boardSize;x++) {
        const cell = board[y][x];
        if(!cell || blocked[`${x},${y}`]) continue;
        for(let [dx,dy] of dirs) {
            let count = 1;
            let nx = x+dx, ny = y+dy;
            while(nx>=0&&nx<boardSize&&ny>=0&&ny<boardSize && board[ny][nx]===cell && !blocked[`${nx},${ny}`]) { count++; nx+=dx; ny+=dy; }
            nx = x-dx; ny = y-dy;
            while(nx>=0&&nx<boardSize&&ny>=0&&ny<boardSize && board[ny][nx]===cell && !blocked[`${nx},${ny}`]) { count++; nx-=dx; ny-=dy; }
            if(count >= 3) {
                const lineCells = [];
                let sx = x, sy = y;
                while(sx-dx>=0 && sy-dy>=0 && sx-dx<boardSize && sy-dy<boardSize && board[sy-dy][sx-dx]===cell && !blocked[`${sx-dx},${sy-dy}`]) { sx-=dx; sy-=dy; }
                for(let i=0;i<3;i++) {
                    const cx = sx + i*dx, cy = sy + i*dy;
                    lineCells.push([cx,cy]);
                }
                const key = lineCells.map(c=>`${c[0]},${c[1]}`).sort().join(';');
                if(!lines.some(l=>l.key===key)) lines.push({ cells: lineCells, team: cell, key });
            }
        }
    }
    return lines;
}

function buildRoundRobinQueue(teams, teamPlayers) {
    const queue = [];
    const maxPlayers = Math.max(...teams.map(t => teamPlayers[t].length));
    for (let i = 0; i < maxPlayers; i++) {
        for (const team of teams) {
            const player = teamPlayers[team][i];
            if (player) queue.push({ team, playerId: player });
        }
    }
    return queue;
}

function nextTurn(room) {
    const game = room.game;
    const queue = game.turnQueue;
    const currentIndex = queue.findIndex(item => item.playerId === game.turnPlayer);
    let nextIndex = (currentIndex + 1) % queue.length;
    while (room.players[queue[nextIndex].playerId]?.online === false) {
        nextIndex = (nextIndex + 1) % queue.length;
        if (nextIndex === currentIndex) break;
    }
    game.turnPlayer = queue[nextIndex].playerId;
    game.currentTurn = queue[nextIndex].team;
}

function startGame(room) {
    const players = Object.values(room.players);
    const teamsPresent = [...new Set(players.map(p=>p.team))].sort((a,b)=> ({X:0,O:1,T:2}[a]-{X:0,O:1,T:2}[b]));
    const teamPlayers = {};
    teamsPresent.forEach(t => { teamPlayers[t] = players.filter(p=>p.team===t).map(p=>p.id); });
    const turnQueue = buildRoundRobinQueue(teamsPresent, teamPlayers);
    const boardSize = room.boardSize;
    const game = {
        board: Array(boardSize).fill().map(()=>Array(boardSize).fill(null)),
        blockedCells: {},
        scores: { X:0, O:0, T:0 },
        lines: [],
        teams: teamsPresent,
        teamPlayers,
        turnQueue,
        currentTurn: turnQueue[0].team,
        turnPlayer: turnQueue[0].playerId,
        winner: null,
        roomName: room.name,
        boardSize,
        players: room.players
    };
    room.game = game;
    broadcastRoom(room.id, { type:'game_started', payload: game });
}

function getRoomPublic(room) {
    return { name: room.name, mode: room.mode, players: room.players, boardSize: room.boardSize };
}

function broadcastRoom(roomId, message) {
    wss.clients.forEach(client => {
        if(client.roomId === roomId && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
    });
}

function addRoomChatMessage(room, senderId, senderNick, text, team) {
    if (!room.chatMessages) room.chatMessages = [];
    room.chatMessages.push({ senderId, senderNick, text, team, timestamp: Date.now() });
    if (room.chatMessages.length > 5) room.chatMessages.shift();
}

function getActiveRooms() {
    const active = [];
    for (let room of rooms.values()) {
        if (!room.game) {
            active.push({
                name: room.name,
                mode: room.mode,
                players: Object.keys(room.players).length,
                maxSlots: room.maxSlots
            });
        }
    }
    return active;
}

// Проверка возможности начать игру (равное количество в непустых командах)
function canStartWithPlayers(room) {
    const players = Object.values(room.players);
    const counts = { X:0, O:0, T:0 };
    players.forEach(p => counts[p.team]++);
    const activeTeams = Object.entries(counts).filter(([_,c]) => c > 0);
    if (activeTeams.length < 2) return false; // минимум две команды
    const firstCount = activeTeams[0][1];
    if (!activeTeams.every(([_,c]) => c === firstCount)) return false;
    if (room.mode === '2x2' && activeTeams.length > 2) return false;
    if (room.mode === '3x3' && activeTeams.length > 3) return false;
    return true;
}

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(500); return res.end('Error'); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else { res.writeHead(404); res.end('Not found'); }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.id = genId();
    ws.roomId = null;
    ws.playerData = null;

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch(e) { return; }
        const { type, payload } = msg;

        if(type === 'create') {
            const { mode, roomName, team, boardSize, nick } = payload;
            if (boardSize === 9 && mode !== '1x1') {
                return ws.send(JSON.stringify({ type:'error', payload:{message:'9x9 доступно только в 1x1'} }));
            }
            const roomId = genId();
            const room = {
                id: roomId, name: roomName, mode, boardSize,
                players: {},
                maxSlots: { '1x1':2, '2x2':4, '3x3':9 }[mode],
                game: null, chatMessages: []
            };
            const playerId = genId();
            room.players[playerId] = { id: playerId, nick, team, ready: false, online: true };
            rooms.set(roomId, room);
            ws.roomId = roomId;
            ws.playerData = { id: playerId, team };
            ws.send(JSON.stringify({ type:'room_created', payload: { roomId, playerId, team, room: getRoomPublic(room) } }));
        }
        else if(type === 'check_room') {
            const room = [...rooms.values()].find(r => r.name === payload.roomName && !r.game);
            if(!room) return ws.send(JSON.stringify({ type:'error', payload:{message:'Комната не найдена'} }));
            const occupied = { X:0, O:0, T:0 };
            Object.values(room.players).forEach(p => occupied[p.team]++);
            ws.send(JSON.stringify({ type:'room_info', payload: { mode: room.mode, occupied, boardSize: room.boardSize } }));
        }
        else if(type === 'get_rooms') {
            ws.send(JSON.stringify({ type:'rooms_list', payload: { rooms: getActiveRooms() } }));
        }
        else if(type === 'join') {
            const { roomName, team, nick } = payload;
            const room = [...rooms.values()].find(r => r.name === roomName && !r.game);
            if(!room) return ws.send(JSON.stringify({ type:'error', payload:{message:'Комната не найдена'} }));
            
            const mode = room.mode;
            const maxPerTeam = { '1x1':1, '2x2':2, '3x3':3 }[mode];
            const occupied = { X:0, O:0, T:0 };
            Object.values(room.players).forEach(p => occupied[p.team]++);
            
            // Определяем доступные команды с учётом ограничений
            let availableTeams = ['X','O','T'];
            
            // Логика для 2x2 и 1x1: если две команды уже "затронуты" (хотя бы один игрок),
            // третья команда недоступна
            if (mode === '2x2' || mode === '1x1') {
                const teamsWithPlayers = Object.entries(occupied).filter(([_,c]) => c > 0).map(([t]) => t);
                if (teamsWithPlayers.length >= 2) {
                    // Оставляем только те команды, в которых уже есть игроки
                    availableTeams = teamsWithPlayers;
                }
                // Для 1x1 максимум одна команда, другая обязательно
                if (mode === '1x1' && teamsWithPlayers.length === 2) {
                    // В 1x1 две команды уже заняты – третью нельзя
                    availableTeams = teamsWithPlayers;
                }
            }
            
            if (!availableTeams.includes(team)) {
                return ws.send(JSON.stringify({ type:'error', payload:{message:'Эта команда сейчас недоступна'} }));
            }
            if(occupied[team] >= maxPerTeam) {
                return ws.send(JSON.stringify({ type:'error', payload:{message:'Команда заполнена'} }));
            }
            
            const playerId = genId();
            room.players[playerId] = { id: playerId, nick, team, ready: false, online: true };
            ws.roomId = room.id;
            ws.playerData = { id: playerId, team };
            ws.send(JSON.stringify({ type:'room_joined', payload: { roomId: room.id, playerId, team, room: getRoomPublic(room) } }));
            broadcastRoom(room.id, { type:'room_update', payload: getRoomPublic(room) });
        }
        else if(type === 'toggle_ready') {
            const room = rooms.get(ws.roomId);
            if(!room || !ws.playerData) return;
            const player = room.players[ws.playerData.id];
            player.ready = !player.ready;
            broadcastRoom(ws.roomId, { type:'room_update', payload: getRoomPublic(room) });
            
            const allReady = Object.values(room.players).every(p => p.ready);
            if (allReady && canStartWithPlayers(room)) {
                startGame(room);
            }
        }
        else if(type === 'leave_room') {
            handleLeaveRoom(ws);
        }
        else if(type === 'preview_move') {
            const room = rooms.get(ws.roomId);
            if(!room || !room.game || room.game.winner) return;
            const game = room.game;
            if(game.currentTurn !== ws.playerData.team) return;
            const { x, y } = payload;
            wss.clients.forEach(client => {
                if(client.roomId === ws.roomId && client.playerData && client.playerData.team === ws.playerData.team && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type:'preview_update', payload: { playerId: ws.playerData.id, x, y } }));
                }
            });
        }
        else if(type === 'make_move') {
            const room = rooms.get(ws.roomId);
            if(!room || !room.game || room.game.winner) return;
            const game = room.game;
            if(game.currentTurn !== ws.playerData.team || game.turnPlayer !== ws.playerData.id) return;
            const { x, y } = payload;
            if(game.board[y][x] !== null || game.blockedCells[`${x},${y}`]) return;
            game.board[y][x] = ws.playerData.team;
            const lines = checkLines(game.board, game.blockedCells, room.boardSize);
            if(lines.length > 0) {
                lines.forEach(line => {
                    line.cells.forEach(([cx,cy]) => { game.blockedCells[`${cx},${cy}`] = true; });
                    game.lines.push({ x1: line.cells[0][0], y1: line.cells[0][1], x2: line.cells[2][0], y2: line.cells[2][1] });
                    game.scores[line.team]++;
                });
            }
            nextTurn(room);
            if(!canAnyTeamFormLine(game.board, game.blockedCells, room.boardSize)) {
                const max = Math.max(...Object.values(game.scores));
                const winners = Object.entries(game.scores).filter(([_,v])=>v===max).map(([k])=>k);
                game.winner = winners.length === 1 ? winners[0] : 'draw';
            }
            broadcastRoom(ws.roomId, { type:'game_update', payload: {
                ...game,
                players: room.players,
                participatingTeams: game.teams.filter(t => game.scores[t] !== undefined || Object.values(room.players).some(p=>p.team===t))
            } });
        }
        else if(type === 'chat_message') {
            const room = rooms.get(ws.roomId);
            if(!room || !ws.playerData) return;
            const { text } = payload;
            const player = room.players[ws.playerData.id];
            if(!player) return;
            addRoomChatMessage(room, ws.playerData.id, player.nick, text, player.team);
            broadcastRoom(ws.roomId, { type: 'chat_message', payload: { senderId: ws.playerData.id, senderNick: player.nick, text, team: player.team } });
        }
        else if(type === 'leave_game') {
            handleLeaveRoom(ws);
        }
    });

    ws.on('close', () => handleLeaveRoom(ws));
});

function handleLeaveRoom(ws) {
    const room = rooms.get(ws.roomId);
    if(!room) return;
    if (ws.playerData) {
        const player = room.players[ws.playerData.id];
        if (player) {
            if (room.game) player.online = false;
            else delete room.players[ws.playerData.id];
        }
    }
    if (room.game) {
        const onlinePlayers = Object.values(room.players).filter(p => p.online !== false);
        const teamsLeft = new Set(onlinePlayers.map(p=>p.team));
        if (teamsLeft.size === 1) room.game.winner = [...teamsLeft][0];
        broadcastRoom(ws.roomId, { type:'game_update', payload: { ...room.game, players: room.players, participatingTeams: room.game.teams.filter(t => room.game.scores[t]!==undefined || onlinePlayers.some(p=>p.team===t)) } });
    } else {
        if (Object.keys(room.players).length === 0) rooms.delete(ws.roomId);
        else broadcastRoom(ws.roomId, { type:'room_update', payload: getRoomPublic(room) });
    }
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
