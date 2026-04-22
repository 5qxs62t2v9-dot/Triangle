const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;

const server = new WebSocket.Server({ port: PORT });
console.log(`WebSocket сервер запущен на порту ${PORT}`);

// Хранилище комнат (в памяти)
const rooms = new Map();

// Генерация ID
function genId() { return Math.random().toString(36).substr(2, 8); }

// Логика проверки линий (3 в ряд)
function checkLines(board) {
    const lines = [];
    const blocked = new Set(); // клетки, которые уже зачёркнуты
    // направления
    const dirs = [[1,0],[0,1],[1,1],[1,-1]];
    for(let y=0;y<9;y++) for(let x=0;x<9;x++) {
        const cell = board[y][x];
        if(!cell) continue;
        for(let [dx,dy] of dirs) {
            let count = 1;
            let nx = x+dx, ny = y+dy;
            while(nx>=0&&nx<9&&ny>=0&&ny<9 && board[ny][nx]===cell) { count++; nx+=dx; ny+=dy; }
            nx = x-dx; ny = y-dy;
            while(nx>=0&&nx<9&&ny>=0&&ny<9 && board[ny][nx]===cell) { count++; nx-=dx; ny-=dy; }
            if(count >= 3) {
                // собрать координаты линии
                const lineCells = [];
                let sx = x, sy = y;
                while(sx-dx>=0 && sy-dy>=0 && sx-dx<9 && sy-dy<9 && board[sy-dy][sx-dx]===cell) { sx-=dx; sy-=dy; }
                for(let i=0;i<3;i++) {
                    const cx = sx + i*dx, cy = sy + i*dy;
                    lineCells.push([cx,cy]);
                }
                const key = lineCells.map(c=>`${c[0]},${c[1]}`).sort().join(';');
                if(!lines.some(l=>l.key===key)) {
                    lines.push({ cells: lineCells, team: cell, key });
                }
            }
        }
    }
    return lines;
}

// Применить зачёркивания и заблокировать клетки
function applyLines(board, lines) {
    const newBoard = board.map(row => [...row]);
    const lineInfos = [];
    lines.forEach(line => {
        line.cells.forEach(([x,y]) => { newBoard[y][x] = null; }); // убираем символ
        lineInfos.push({
            x1: line.cells[0][0], y1: line.cells[0][1],
            x2: line.cells[2][0], y2: line.cells[2][1]
        });
    });
    return { board: newBoard, lineInfos };
}

// Подсчёт очков команд
function countScores(lines) {
    const scores = { X:0, O:0, T:0 };
    lines.forEach(l => scores[l.team]++);
    return scores;
}

// Проверка завершения игры (нет возможных троек)
function isGameFinished(board) {
    // упрощённо: если есть хоть одна возможная тройка? Для простоты проверяем возможность любого хода
    for(let y=0;y<9;y++) for(let x=0;x<9;x++) if(board[y][x]===null) return false;
    return true;
}

// Обработка сообщений
server.on('connection', (ws) => {
    ws.id = genId();
    ws.roomId = null;
    ws.playerData = null;

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch(e) { return; }
        const { type, payload } = msg;

        if(type === 'create') {
            const { mode, roomName, team, nick } = payload;
            const roomId = genId();
            const room = {
                id: roomId, name: roomName, mode,
                players: {},
                maxSlots: { '1x1':2, '2x2':4, '3x3':9 }[mode],
                teams: { X:[], O:[], T:[] },
                readyCount: 0,
                game: null
            };
            const playerId = genId();
            room.players[playerId] = { id: playerId, nick, team, ready: false };
            rooms.set(roomId, room);
            ws.roomId = roomId;
            ws.playerData = { id: playerId, team };
            ws.send(JSON.stringify({ type:'room_created', payload: { roomId, playerId, team, room: getRoomPublic(room) } }));
        }
        else if(type === 'join') {
            const { roomName, team, nick } = payload;
            const room = [...rooms.values()].find(r => r.name === roomName && !r.game);
            if(!room) return ws.send(JSON.stringify({ type:'error', payload:{message:'Комната не найдена'} }));
            const teamSlots = { '1x1':{X:1,O:1}, '2x2':{X:2,O:2}, '3x3':{X:3,O:3,T:3} }[room.mode];
            const currentCount = Object.values(room.players).filter(p=>p.team===team).length;
            if(currentCount >= teamSlots[team]) return ws.send(JSON.stringify({ type:'error', payload:{message:'Команда заполнена'} }));
            const playerId = genId();
            room.players[playerId] = { id: playerId, nick, team, ready: false };
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
            const allReady = Object.values(room.players).every(p=>p.ready) && Object.keys(room.players).length === room.maxSlots;
            if(allReady) startGame(room);
        }
        else if(type === 'leave_room') {
            handleLeaveRoom(ws);
        }
        else if(type === 'make_move') {
            const room = rooms.get(ws.roomId);
            if(!room || !room.game || room.game.winner) return;
            const game = room.game;
            if(game.currentTurn !== ws.playerData.team || game.turnPlayer !== ws.playerData.id) return;
            const { x, y } = payload;
            if(game.board[y][x] !== null) return;
            // применить ход
            game.board[y][x] = ws.playerData.team;
            // проверка линий
            const lines = checkLines(game.board);
            if(lines.length > 0) {
                const { board: newBoard, lineInfos } = applyLines(game.board, lines);
                game.board = newBoard;
                game.lines.push(...lineInfos);
                const scores = countScores(lines);
                game.scores.X += scores.X; game.scores.O += scores.O; game.scores.T += scores.T;
            }
            // следующий ход
            advanceTurn(room);
            // проверка окончания
            if(isGameFinished(game.board) || Object.keys(room.players).length <=1) {
                const winner = determineWinner(game.scores);
                game.winner = winner;
            }
            broadcastRoom(ws.roomId, { type:'game_update', payload: game });
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
    if(ws.playerData) delete room.players[ws.playerData.id];
    if(Object.keys(room.players).length === 0) rooms.delete(ws.roomId);
    else {
        if(room.game) {
            if(room.game.winner) {} // ничего
            else {
                // игра продолжается в 2x2/3x3, если осталась одна команда - конец
                const teamsLeft = new Set(Object.values(room.players).map(p=>p.team));
                if(teamsLeft.size === 1) {
                    room.game.winner = [...teamsLeft][0];
                }
                broadcastRoom(ws.roomId, { type:'game_update', payload: room.game });
            }
        }
        broadcastRoom(ws.roomId, { type:'room_update', payload: getRoomPublic(room) });
    }
}

function startGame(room) {
    const playersList = Object.values(room.players);
    // определить порядок команд и игроков
    const order = ['X','O','T'].filter(t => playersList.some(p=>p.team===t));
    const turnOrder = [];
    order.forEach(team => {
        const teamPlayers = playersList.filter(p=>p.team===team).map(p=>p.id);
        turnOrder.push({ team, players: teamPlayers, index: 0 });
    });
    const game = {
        board: Array(9).fill().map(()=>Array(9).fill(null)),
        scores: { X:0, O:0, T:0 },
        lines: [],
        turnOrder,
        currentTurnIndex: 0,
        currentTurn: order[0],
        turnPlayer: turnOrder[0].players[0],
        winner: null
    };
    room.game = game;
    broadcastRoom(room.id, { type:'game_started', payload: game });
}

function advanceTurn(room) {
    const game = room.game;
    const order = game.turnOrder;
    let current = order[game.currentTurnIndex];
    // следующий игрок в команде
    current.index = (current.index + 1) % current.players.length;
    game.turnPlayer = current.players[current.index];
    // если вернулись к первому, переходим к следующей команде
    if(current.index === 0) {
        game.currentTurnIndex = (game.currentTurnIndex + 1) % order.length;
        const nextTeam = order[game.currentTurnIndex];
        game.currentTurn = nextTeam.team;
        game.turnPlayer = nextTeam.players[nextTeam.index];
    }
}

function determineWinner(scores) {
    const max = Math.max(scores.X, scores.O, scores.T);
    const winners = Object.entries(scores).filter(([_,v])=>v===max).map(([k])=>k);
    return winners.length === 1 ? winners[0] : 'draw';
}

function getRoomPublic(room) {
    return {
        name: room.name, mode: room.mode,
        players: room.players,
    };
}

function broadcastRoom(roomId, message) {
    server.clients.forEach(client => {
        if(client.roomId === roomId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}
