const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

const rooms = new Map();

function genId() { return Math.random().toString(36).substr(2, 8); }

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
                if(!lines.some(l=>l.key===key)) {
                    lines.push({ cells: lineCells, team: cell, key });
                }
            }
        }
    }
    return lines;
}

function startGame(room) {
    const players = Object.values(room.players);
    const teamsPresent = [...new Set(players.map(p=>p.team))].sort((a,b)=> ({X:0,O:1,T:2}[a]-{X:0,O:1,T:2}[b]));
    const teamPlayers = {};
    teamsPresent.forEach(t => { teamPlayers[t] = players.filter(p=>p.team===t).map(p=>p.id); });
    
    const boardSize = room.boardSize;
    const game = {
        board: Array(boardSize).fill().map(()=>Array(boardSize).fill(null)),
        blockedCells: {},
        scores: { X:0, O:0, T:0 },
        lines: [],
        teams: teamsPresent,
        teamPlayers,
        currentTeamIdx: 0,
        playerIdx: 0,
        currentTurn: teamsPresent[0],
        turnPlayer: teamPlayers[teamsPresent[0]][0],
        winner: null,
        roomName: room.name,
        boardSize
    };
    room.game = game;
    broadcastRoom(room.id, { type:'game_started', payload: game });
}

function advanceTurn(room) {
    const game = room.game;
    const teams = game.teams;
    const currentTeam = teams[game.currentTeamIdx];
    game.playerIdx = (game.playerIdx + 1) % game.teamPlayers[currentTeam].length;
    game.currentTeamIdx = (game.currentTeamIdx + 1) % teams.length;
    const nextTeam = teams[game.currentTeamIdx];
    game.currentTurn = nextTeam;
    game.turnPlayer = game.teamPlayers[nextTeam][game.playerIdx];
}

function getRoomPublic(room) {
    return {
        name: room.name, mode: room.mode,
        players: room.players,
        boardSize: room.boardSize
    };
}

function broadcastRoom(roomId, message) {
    wss.clients.forEach(client => {
        if(client.roomId === roomId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
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
                return ws.send(JSON.stringify({ type:'error', payload:{message:'9x9 доступно только в режиме 1x1'} }));
            }
            const roomId = genId();
            const room = {
                id: roomId, name: roomName, mode, boardSize,
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
            const room = [...rooms.values()].find(r => r.name === payload.roomName && !r.game);
            if(!room) return ws.send(JSON.stringify({ type:'error', payload:{message:'Комната не найдена'} }));
            const occupied = { X:0, O:0, T:0 };
            Object.values(room.players).forEach(p => occupied[p.team]++);
            ws.send(JSON.stringify({ type:'room_info', payload: { mode: room.mode, occupied, boardSize: room.boardSize } }));
        }
        else if(type === 'join') {
            const { roomName, team, nick } = payload;
            const room = [...rooms.values()].find(r => r.name === roomName && !r.game);
            if(!room) return ws.send(JSON.stringify({ type:'error', payload:{message:'Комната не найдена'} }));
            const maxPerTeam = { '1x1':1, '2x2':2, '3x3':3 }[room.mode];
            const occupied = { X:0, O:0, T:0 };
            Object.values(room.players).forEach(p => occupied[p.team]++);
            let availableTeams = ['X','O','T'];
            if (room.mode === '2x2') {
                const fullTeams = Object.entries(occupied).filter(([_,c])=>c===2).map(([t])=>t);
                const startedTeams = Object.entries(occupied).filter(([_,c])=>c>0).map(([t])=>t);
                if (fullTeams.length === 1 && startedTeams.length >= 2) {
                    availableTeams = startedTeams;
                }
            }
            if (!availableTeams.includes(team)) {
                return ws.send(JSON.stringify({ type:'error', payload:{message:'Эта команда сейчас недоступна'} }));
            }
            if(occupied[team] >= maxPerTeam) {
                return ws.send(JSON.stringify({ type:'error', payload:{message:'Команда заполнена'} }));
            }
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
            const players = Object.values(room.players);
            const allReady = players.every(p=>p.ready);
            const enoughPlayers = players.length === room.maxSlots;
            let canStart = allReady && enoughPlayers;
            if (room.mode === '3x3' && canStart) {
                const counts = { X:0, O:0, T:0 };
                players.forEach(p => counts[p.team]++);
                const activeTeams = Object.values(counts).filter(c => c > 0);
                if (new Set(activeTeams).size > 1) {
                    canStart = false;
                }
            }
            if (canStart) {
                startGame(room);
            }
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
            if(game.board[y][x] !== null || game.blockedCells[`${x},${y}`]) return;
            game.board[y][x] = ws.playerData.team;
            const lines = checkLines(game.board, game.blockedCells, room.boardSize);
            if(lines.length > 0) {
                lines.forEach(line => {
                    line.cells.forEach(([cx,cy]) => { game.blockedCells[`${cx},${cy}`] = true; });
                    game.lines.push({
                        x1: line.cells[0][0], y1: line.cells[0][1],
                        x2: line.cells[2][0], y2: line.cells[2][1]
                    });
                    game.scores[line.team]++;
                });
            }
            advanceTurn(room);
            if(!canAnyTeamFormLine(game.board, game.blockedCells, room.boardSize)) {
                const max = Math.max(game.scores.X||0, game.scores.O||0, game.scores.T||0);
                const winners = Object.entries(game.scores).filter(([_,v])=>v===max).map(([k])=>k);
                game.winner = winners.length === 1 ? winners[0] : 'draw';
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

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
