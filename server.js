const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;

const server = new WebSocket.Server({ port: PORT });
console.log(`WebSocket сервер запущен на порту ${PORT}`);

const rooms = new Map();

function genId() { return Math.random().toString(36).substr(2, 8); }

// Проверка, можно ли ещё собрать тройку (любой командой)
function canAnyTeamFormLine(board) {
    const teams = ['X','O','T'];
    const dirs = [[1,0],[0,1],[1,1],[1,-1]];
    for (let team of teams) {
        for (let y = 0; y < 9; y++) {
            for (let x = 0; x < 9; x++) {
                if (board[y][x] !== null && board[y][x] !== team) continue;
                for (let [dx,dy] of dirs) {
                    let count = 0;
                    let empty = 0;
                    for (let i = 0; i < 3; i++) {
                        const nx = x + i*dx, ny = y + i*dy;
                        if (nx<0||nx>=9||ny<0||ny>=9) break;
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

function checkLines(board) {
    const lines = [];
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

function applyLines(board, lines) {
    const newBoard = board.map(row => [...row]);
    const lineInfos = [];
    lines.forEach(line => {
        line.cells.forEach(([x,y]) => { newBoard[y][x] = null; });
        lineInfos.push({
            x1: line.cells[0][0], y1: line.cells[0][1],
            x2: line.cells[2][0], y2: line.cells[2][1]
        });
    });
    return { board: newBoard, lineInfos };
}

function countScores(lines) {
    const scores = { X:0, O:0, T:0 };
    lines.forEach(l => scores[l.team]++);
    return scores;
}

function isGameFinished(board) {
    return !canAnyTeamFormLine(board);
}

function determineWinner(scores) {
    const max = Math.max(scores.X, scores.O, scores.T);
    const winners = Object.entries(scores).filter(([_,v])=>v===max).map(([k])=>k);
    return winners.length === 1 ? winners[0] : 'draw';
}

// Новая логика очерёдности ходов
function startGame(room) {
    const players = Object.values(room.players);
    const teamsPresent = [...new Set(players.map(p=>p.team))].sort((a,b)=> {
        const order = { X:0, O:1, T:2 };
        return order[a] - order[b];
    });
    const teamPlayers = {};
    teamsPresent.forEach(t => { teamPlayers[t] = players.filter(p=>p.team===t).map(p=>p.id); });
    const game = {
        board: Array(9).fill().map(()=>Array(9).fill(null)),
        scores: { X:0, O:0, T:0 },
        lines: [],
        teams: teamsPresent,
        teamPlayers,
        currentTeamIdx: 0,
        playerIdx: 0,          // индекс текущего игрока внутри текущей команды
        currentTurn: teamsPresent[0],
        turnPlayer: teamPlayers[teamsPresent[0]][0],
        winner: null,
        roomName: room.name
    };
    room.game = game;
    broadcastRoom(room.id, { type:'game_started', payload: game });
}

function advanceTurn(room) {
    const game = room.game;
    const teams = game.teams;
    const currentTeam = teams[game.currentTeamIdx];
    // Переходим к следующему игроку в текущей команде
    game.playerIdx = (game.playerIdx + 1) % game.teamPlayers[currentTeam].length;
    // Переходим к следующей команде
    game.currentTeamIdx = (game.currentTeamIdx + 1) % teams.length;
    const nextTeam = teams[game.currentTeamIdx];
    game.currentTurn = nextTeam;
    // Если перешли на новую команду, берём её первого игрока (если не первый круг)
    if (game.playerIdx === 0) {
        // уже перешли на следующую команду, playerIdx сброшен в 0 после увеличения?
        // Логика: после хода игрока мы увеличиваем playerIdx, затем переключаем команду.
        // Поэтому для новой команды нужно использовать её текущий индекс (он не менялся)
    }
    // Устанавливаем игрока для хода
    game.turnPlayer = game.teamPlayers[nextTeam][game.playerIdx];
}

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
                game: null
            };
            const playerId = genId();
            room.players[playerId] = { id: playerId, nick, team, ready: false };
            rooms.set(roomId, room);
            ws.roomId = roomId;
            ws.playerData = { id: playerId, team };
            ws.send(JSON.stringify({ type:'room_created', payload: { roomId, playerId, team, room: getRoomPublic(room) } }));
        }
        else if(type === 'check_room') {
            const { roomName } = payload;
            const room = [...rooms.values()].find(r => r.name === roomName && !r.game);
            if(!room) return ws.send(JSON.stringify({ type:'error', payload:{message:'Комната не найдена'} }));
            const occupied = { X:0, O:0, T:0 };
            Object.values(room.players).forEach(p => occupied[p.team]++);
            ws.send(JSON.stringify({ type:'room_info', payload: { mode: room.mode, occupied } }));
        }
        else if(type === 'join') {
            const { roomName, team, nick } = payload;
            const room = [...rooms.values()].find(r => r.name === roomName && !r.game);
            if(!room) return ws.send(JSON.stringify({ type:'error', payload:{message:'Комната не найдена'} }));
            const maxPerTeam = { '1x1':1, '2x2':2, '3x3':3 }[room.mode];
            const currentCount = Object.values(room.players).filter(p=>p.team===team).length;
            if(currentCount >= maxPerTeam) return ws.send(JSON.stringify({ type:'error', payload:{message:'Команда заполнена'} }));
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
            game.board[y][x] = ws.playerData.team;
            const lines = checkLines(game.board);
            if(lines.length > 0) {
                const { board: newBoard, lineInfos } = applyLines(game.board, lines);
                game.board = newBoard;
                game.lines.push(...lineInfos);
                const scores = countScores(lines);
                game.scores.X += scores.X; game.scores.O += scores.O; game.scores.T += scores.T;
            }
            advanceTurn(room);
            if(isGameFinished(game.board)) {
                game.winner = determineWinner(game.scores);
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
    if(Object.keys(room.players).length === 0) {
        rooms.delete(ws.roomId);
        return;
    }
    if(room.game) {
        if(room.mode === '1x1') {
            // в 1x1 при выходе игра завершается, оставшийся побеждает
            const remaining = Object.values(room.players)[0];
            room.game.winner = remaining ? remaining.team : 'draw';
            broadcastRoom(ws.roomId, { type:'game_update', payload: room.game });
        } else {
            const teamsLeft = new Set(Object.values(room.players).map(p=>p.team));
            if(teamsLeft.size === 1) {
                room.game.winner = [...teamsLeft][0];
                broadcastRoom(ws.roomId, { type:'game_update', payload: room.game });
            } else {
                broadcastRoom(ws.roomId, { type:'game_update', payload: room.game });
            }
        }
    }
    broadcastRoom(ws.roomId, { type:'room_update', payload: getRoomPublic(room) });
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
