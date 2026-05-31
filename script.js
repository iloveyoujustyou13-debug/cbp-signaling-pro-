const WebSocket = require('ws');
const http = require('http');

// ক্লাউড প্ল্যাটফর্মের ডিফল্ট পোর্ট ডিটেকশন
const PORT = process.env.PORT || 3000;

// একটি বেসিক HTTP সার্ভার তৈরি করা (Render-এর হেলথ চেকের জন্য জরুরি)
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CBP Ultimate Cloud Routing Engine v7.0.0 is Running Perfectly!\n');
});

const wss = new WebSocket.Server({ server });

// 🗺️ মেমোরি ডাটাবেজ (রুম এবং মনিটর ট্র্যাক রাখার জন্য)
let activeBroadcastRooms = {}; 
let activeMonitorTokens = {};  

// ক্যামেরা কানেকশনের জন্য ৫-ডিজিটের ইউনিক কোড জেনারেটর
function generateCameraCode() {
    const pool = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'CBP-';
    for (let i = 0; i < 5; i++) {
        code += pool.charAt(Math.floor(Math.random() * pool.length));
    }
    return code;
}

wss.on('connection', (ws) => {
    // কানেক্ট হওয়া প্রতিটা সকেটের ডিফল্ট প্রোপার্টি ইনিশিয়ালাইজেশন
    ws.nodeId = null;
    ws.roomCode = null;
    ws.nodeRole = null;
    ws.assignedMonitorToken = null;

    ws.on('message', (message) => {
        let packet;
        try { 
            packet = JSON.parse(message); 
        } catch (e) { 
            return; // ইনভ্যালিড ডাটা আসলে ইগনোর করবে
        }

        switch (packet.type) {
            
            // 🎬 ১. ডিরেক্টর মেইন ডেস্ক রুম তৈরি করা
            case 'create_room':
                const newCode = generateCameraCode();
                ws.nodeId = 'director_' + Math.random().toString(36).substr(2, 9);
                ws.roomCode = newCode;
                ws.nodeRole = 'director';

                activeBroadcastRooms[newCode] = { 
                    directorSocket: ws, 
                    connectedCameras: {} 
                };
                
                ws.send(JSON.stringify({ type: 'room_created', roomCode: newCode }));
                console.log(`[STATION] Director launched Master Studio: ${newCode}`);
                break;

            // 🖥️ ২. ডিরেক্টর ডেস্ক থেকে ১০-ডিজিটের মনিটর টোকেন রেজিস্টার করা
            case 'register_monitor_node':
                if (ws.nodeRole === 'director' && ws.roomCode) {
                    const monitorToken = packet.monitorCode;
                    
                    // মনিটর টোকেন ম্যাপিং ডিরেক্টরের সাথে লক করা হলো
                    activeMonitorTokens[monitorToken] = {
                        directorSocket: ws,
                        masterRoomCode: ws.roomCode,
                        monitorSocket: null
                    };
                    console.log(`[MONITOR MATRIX] 10-Digit Token Armed: ${monitorToken} -> Linked to ${ws.roomCode}`);
                }
                break;

            // 🎥 ৩. মাঠের ক্যামেরা নোড যুক্ত হওয়া (৫-ডিজিট কোড দিয়ে)
            case 'join_room':
                const targetCode = packet.roomCode;
                if (activeBroadcastRooms[targetCode]) {
                    const camSlotId = 'cam' + (Object.keys(activeBroadcastRooms[targetCode].connectedCameras).length + 1);
                    
                    ws.nodeId = camSlotId;
                    ws.roomCode = targetCode;
                    ws.nodeRole = 'camera';

                    activeBroadcastRooms[targetCode].connectedCameras[camSlotId] = ws;
                    ws.send(JSON.stringify({ type: 'joined_successfully', cameraId: camSlotId }));

                    // ডিরেক্টর প্যানেলকে রিয়েল-টাইম নোটিফিকেশন পাঠানো
                    activeBroadcastRooms[targetCode].directorSocket.send(JSON.stringify({ 
                        type: 'camera_joined', 
                        cameraId: camSlotId 
                    }));
                    console.log(`[CAMERA] Cam Node [${camSlotId}] attached to Studio ${targetCode}`);
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'ভুল স্টুডিও কোড! আবার চেষ্টা করুন।' }));
                }
                break;

            // 🖥️ ৪. সেকেন্ডারি মনিটর ফোন যুক্ত হওয়া (১০-ডিজিট টোকেন দিয়ে)
            case 'join_monitor_room':
                const tokenInput = packet.roomCode;
                if (activeMonitorTokens[tokenInput]) {
                    const monitorUniqueId = 'monitor_' + Math.random().toString(36).substr(2, 9);
                    
                    ws.nodeId = monitorUniqueId;
                    ws.nodeRole = 'monitor';
                    ws.assignedMonitorToken = tokenInput;

                    ws.send(JSON.stringify({ type: 'monitor_joined_successfully' }));

                    // মেইন ডিরেক্টরকে ট্রিগার করা যে মনিটর রেডি, WebRTC পাইপলাইন চালু করো
                    const currentDirector = activeMonitorTokens[tokenInput].directorSocket;
                    if (currentDirector && currentDirector.readyState === WebSocket.OPEN) {
                        activeMonitorTokens[tokenInput].monitorSocket = ws;
                        currentDirector.send(JSON.stringify({ 
                            type: 'monitor_requested', 
                            monitorId: monitorUniqueId 
                        }));
                        console.log(`[MONITOR] Virtual Monitor Linked via Token: ${tokenInput}`);
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'মনিটর টোকেনটি সঠিক নয় বা এক্সপায়ার হয়ে গেছে!' }));
                }
                break;

            // ⚡ ৫. WebRTC আল্ট্রা-ফাস্ট সিগন্যালিং রিলে (Offer, Answer, ICE Candidates)
            case 'offer':
            case 'answer':
            case 'ice-candidate':
                if (ws.nodeRole === 'director') {
                    // ডিরেক্টর যখন মনিটর সকেটকে সিগন্যাল পাঠাবে
                    const currentToken = Object.keys(activeMonitorTokens).find(k => activeMonitorTokens[k].directorSocket === ws);
                    if (currentToken && activeMonitorTokens[currentToken].monitorSocket && activeMonitorTokens[currentToken].monitorSocket.nodeId === packet.targetId) {
                        packet.targetId = ws.nodeId; 
                        activeMonitorTokens[currentToken].monitorSocket.send(JSON.stringify(packet));
                    } 
                    // ডিরেক্টর যখন কোনো নির্দিষ্ট ক্যামেরাকে সিগন্যাল পাঠাবে
                    else if (activeBroadcastRooms[ws.roomCode]) {
                        const targetCamNode = activeBroadcastRooms[ws.roomCode].connectedCameras[packet.targetId];
                        if (targetCamNode) {
                            packet.cameraId = ws.nodeId;
                            targetCamNode.send(JSON.stringify(packet));
                        }
                    }
                } 
                // ক্যামেরা থেকে ডিরেক্টরের দিকে ডাটা পাস করা
                else if (ws.nodeRole === 'camera' && activeBroadcastRooms[ws.roomCode]) {
                    packet.cameraId = ws.nodeId;
                    activeBroadcastRooms[ws.roomCode].directorSocket.send(JSON.stringify(packet));
                } 
                // ভার্চুয়াল মনিটর থেকে ডিরেক্টরের দিকে ডাটা পাস করা
                else if (ws.nodeRole === 'monitor' && activeMonitorTokens[ws.assignedMonitorToken]) {
                    packet.targetId = ws.nodeId;
                    activeMonitorTokens[ws.assignedMonitorToken].directorSocket.send(JSON.stringify(packet));
                }
                break;
        }
    });

    // 🛑 কোনো ডিভাইস ডিসকানেক্ট বা নেটওয়ার্ক ড্রপ করলে ক্লিনআপ লজিক
    ws.on('close', () => {
        if (ws.nodeRole === 'director' && ws.roomCode) {
            console.log(`[STATION SHUTDOWN] Director closed room ${ws.roomCode}`);
            delete activeBroadcastRooms[ws.roomCode];
            
            // মনিটর ডাটাবেজ ক্লিনআপ
            Object.keys(activeMonitorTokens).forEach(token => {
                if (activeMonitorTokens[token].directorSocket === ws) {
                    if (activeMonitorTokens[token].monitorSocket) {
                        activeMonitorTokens[token].monitorSocket.send(JSON.stringify({ type: 'disconnect' }));
                    }
                    delete activeMonitorTokens[token];
                }
            });
        } 
        else if (ws.nodeRole === 'camera' && activeBroadcastRooms[ws.roomCode]) {
            console.log(`[CAMERA OFFLINE] Cam Node ${ws.nodeId} dropped from room ${ws.roomCode}`);
            delete activeBroadcastRooms[ws.roomCode].connectedCameras[ws.nodeId];
            activeBroadcastRooms[ws.roomCode].directorSocket.send(JSON.stringify({ type: 'disconnect', nodeId: ws.nodeId }));
        }
        else if (ws.nodeRole === 'monitor' && activeMonitorTokens[ws.assignedMonitorToken]) {
            console.log(`[MONITOR OFFLINE] Virtual Monitor unlinked from token ${ws.assignedMonitorToken}`);
            activeMonitorTokens[ws.assignedMonitorToken].monitorSocket = null;
        }
    });
});

server.listen(PORT, () => console.log(`CBP Cloud Signal Engine Deployment Success on Port ${PORT}`));
            
