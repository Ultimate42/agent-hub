"""Relais de l'atelier ComfyUI (GPU.md, « Veille de l'atelier ») : un petit programme qui écoute à la place de ComfyUI.

Pourquoi : ComfyUI au repos garde plus de 3 Go de mémoire vive. Le worker l'arrête après quelques minutes sans
travail ; ce relais reste à sa place, sur le même port (8188), les mêmes adresses (127.0.0.1 et l'adresse Tailscale) et
le même Python (celui de l'atelier, que vise le pare-feu Windows) : rien ne change pour le poste client.

Ce qu'il fait :
- une connexion arrive et ComfyUI dort : il demande au worker de le démarrer (fichier d'état, state « démarrage »),
  attend qu'il réponde, puis relaie. Le worker démarre ComfyUI sur 127.0.0.1 seulement, sur un port interne ;
- une connexion arrive et ComfyUI répond : relayée telle quelle, octet par octet (HTTP, keep-alive, WebSocket /ws) ;
- un WebSocket ouvert pendant que ComfyUI dort ne le réveille pas (un onglet oublié se reconnecte sans fin) : le relais
  accepte la poignée de main lui-même et garde la connexion ; au réveil (premier appel HTTP), il la branche sur ComfyUI
  AVANT de relayer cet appel, pour que les messages d'un /prompt ne se perdent pas ;
- un appel HTTP/1.1 qui attend le réveil (ComfyUI à froid : jusqu'à plusieurs minutes) ne reste pas sans un octet : toutes les
  HEARTBEAT_S secondes le relais envoie « 100 Continue » (réponse intermédiaire, que le client doit sauter, RFC 9110 §15.2), ce qui
  relance le délai « aucune donnée reçue » des clients. Un client parti est vu à cet envoi : son attente est retirée (le worker ne
  croit plus qu'un appel attend) ;
- il note la dernière activité HTTP (octets dans un sens ou l'autre) : le worker ne met ComfyUI en veille qu'après
  atelier_idle_stop_minutes sans activité ni calcul, file /queue lue vide.

Ce qu'il ne fait pas : démarrer ou arrêter ComfyUI (le worker le fait : carte, environnement, journal), ni écouter
ailleurs que sur les adresses données (jamais 0.0.0.0). Seulement la bibliothèque standard : quelques Mo de mémoire.

Lancé par le worker : python -s atelier_relay.py --listen 127.0.0.1,100.x.y.z --port 8188 --backend 8189
                      --state <atelier>/relay.json [--allow 100.a.b.c] [--wait 300] [--heartbeat 10]
"""
import argparse
import base64
import hashlib
import http.client
import ipaddress
import json
import os
import select
import socket
import sys
import threading
import time

HEAD_MAX = 64 * 1024        # en-têtes d'une requête
HEAD_TIMEOUT_S = 30         # une connexion muette est fermée
DORMANT_MAX = 16            # WebSockets gardés pendant la veille, au plus
DORMANT_BUFFER = 64 * 1024  # octets envoyés par un WebSocket gardé, relayés au réveil
ATTACH_WAIT_S = 10          # au réveil, branchement des WebSockets gardés avant de relayer le premier appel
FLUSH_S = 5                 # dernière activité écrite au plus toutes les 5 s
HEARTBEAT_S = 10            # un appel HTTP qui attend le réveil reçoit un signe de vie toutes les 10 s (0 : aucun)
INTERIM = b'HTTP/1.1 100 Continue\r\n\r\n'   # le seul « 1xx » que tous les clients HTTP/1.1 courants sautent (http.client, undici, aiohttp, Go, curl)
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
LOOPBACK = ipaddress.ip_network('127.0.0.0/8')
try:   # empreinte de ce fichier : le worker relance un relais repris d'une version précédente (quand l'atelier ne calcule pas)
    with open(__file__, 'rb') as _f:
        SHA = hashlib.sha256(_f.read()).hexdigest()[:12]
except OSError:
    SHA = None


def now_text(t=None):
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(t if t is not None else time.time()))


def parse_head(data):
    """En-têtes d'une requête -> (méthode, cible, {nom en minuscules: valeur}) ; ValueError si illisible."""
    text = data.split(b'\r\n\r\n', 1)[0].decode('latin-1')
    lines = text.split('\r\n')
    parts = lines[0].split(' ')
    if len(parts) != 3 or not parts[2].startswith('HTTP/'):
        raise ValueError('ligne de requête illisible')
    headers = {}
    for line in lines[1:]:
        name, sep, value = line.partition(':')
        if sep:
            headers[name.strip().lower()] = value.strip()
    return parts[0], parts[1], headers


def is_websocket(headers):
    return headers.get('upgrade', '').lower() == 'websocket' and 'upgrade' in headers.get('connection', '').lower()


def ws_accept(key):
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode('latin-1')).digest()).decode('ascii')


def without_header(head, name):
    """Les en-têtes sans celui-là (ici Sec-WebSocket-Extensions : la poignée de main faite par le relais n'a rien négocié,
    ComfyUI ne doit donc pas compresser)."""
    lines = head.split(b'\r\n\r\n', 1)[0].split(b'\r\n')
    kept = [l for l in lines if not l.lower().startswith(name.lower().encode('latin-1') + b':')]
    return b'\r\n'.join(kept) + b'\r\n\r\n'


def peer_allowed(ip, allow):
    """127.0.0.0/8 toujours ; sinon l'adresse doit être dans allow (vide : le pare-feu seul décide, comme avant)."""
    try:
        a = ipaddress.ip_address(ip.split('%')[0])
    except ValueError:
        return False
    if getattr(a, 'ipv4_mapped', None):
        a = a.ipv4_mapped
    return a in LOOPBACK or not allow or str(a) in allow


def answer(sock, code, reason, body):
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    try:
        sock.sendall(('HTTP/1.1 %d %s\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: %d\r\n'
                      'Connection: close\r\n\r\n' % (code, reason, len(data))).encode('latin-1') + data)
    except OSError:
        pass


def client_gone(sock):
    """Le client a-t-il fermé sa connexion ? (lecture sans consommer : octet en attente = pas parti)"""
    try:
        ready, _, _ = select.select([sock], [], [], 0)
        return bool(ready) and sock.recv(1, socket.MSG_PEEK) == b''
    except OSError:
        return True


def send_interim(sock, http11=True):
    """Pulsation d'un appel qui attend : signe de vie à un client HTTP/1.1 (jamais à un autre : pas de 1xx en HTTP/1.0).
    -> False si le client n'est plus là."""
    if client_gone(sock):
        return False
    if not http11:
        return True
    try:
        sock.sendall(INTERIM)
        return True
    except OSError:
        return False


def splice(a, b, on_bytes=None, first=b''):
    """Relaie dans les deux sens jusqu'à ce qu'un côté ferme (ou une erreur), puis ferme les deux. first : déjà lu de a,
    à envoyer à b d'abord."""
    try:
        if first:
            b.sendall(first)
        other = {a: b, b: a}
        while True:
            ready, _, _ = select.select([a, b], [], [], 60)
            for s in ready:
                data = s.recv(65536)
                if not data:
                    return
                other[s].sendall(data)
                if on_bytes:
                    on_bytes()
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.close()
            except OSError:
                pass


class Relay:
    def __init__(self, listen, port, backend, state_path, allow=(), wait_s=300.0, probe_s=2.0, heartbeat_s=HEARTBEAT_S):
        self.listen, self.port, self.backend = listen, port, backend
        self.heartbeat_s = heartbeat_s
        self.state_path, self.allow, self.wait_s, self.probe_s = state_path, set(allow), wait_s, probe_s
        self.allow_list = list(allow)
        self.lock = threading.Lock()
        self.flush_lock = threading.Lock()
        self.up = threading.Event()        # ComfyUI répond (vu par la sonde)
        self.ready = threading.Event()     # ... et les WebSockets gardés sont branchés : les appels HTTP passent
        self.kick = threading.Event()      # un appel attend : sonder tout de suite
        self.waiters = 0
        self.dormant = []                  # WebSockets gardés pendant la veille : [Dormant]
        self.ws_open = 0
        self.state = 'veille'
        self.started_at = now_text()
        self.last_activity = None          # temps (s) du dernier octet HTTP relayé
        self.wake_at = None
        self.wake_cause = None
        self.pending_cause = None
        self.wakes = 0
        self.connections = 0
        self.refused = 0
        self.timeouts = 0
        self.dirty = True
        self.flushed_at = 0.0
        self.stopping = threading.Event()

    # ---- état partagé avec le worker (fichier JSON, remplacé d'un coup) ----
    def snapshot(self):
        return {'pid': os.getpid(), 'sha': SHA, 'listen': ','.join(self.listen), 'allow': ','.join(self.allow_list), 'port': self.port,
                'backend_port': self.backend,
                'state': self.state, 'started_at': self.started_at, 'last_activity_at': self.last_activity, 'wake_at': self.wake_at,
                'wake_cause': self.wake_cause, 'wakes': self.wakes, 'waiting': self.waiters, 'ws_open': self.ws_open,
                'ws_dormant': len(self.dormant), 'connections': self.connections, 'refused': self.refused, 'timeouts': self.timeouts,
                'written_at': time.time()}

    def flush(self, force=False):
        """État écrit d'un coup (fichier temporaire puis remplacement). Un seul écrivain à la fois, l'instantané pris sous
        le même verrou : un état plus ancien n'écrase jamais un plus récent."""
        if not (force or self.dirty) or (not force and time.time() - self.flushed_at < FLUSH_S):
            return
        with self.flush_lock:
            with self.lock:
                data = json.dumps(self.snapshot(), ensure_ascii=False)
                self.dirty = False
            tmp = self.state_path + '.tmp'
            for _ in range(5):   # Windows : le worker peut lire le fichier à cet instant (os.replace refusé)
                try:
                    with open(tmp, 'w', encoding='utf-8') as f:
                        f.write(data)
                    os.replace(tmp, self.state_path)
                    self.flushed_at = time.time()
                    return
                except OSError:
                    time.sleep(0.05)
            self.dirty = True

    def set_state(self, state):
        with self.lock:
            if self.state != state:
                self.state = state
                self.dirty = True
                changed = True
            else:
                changed = False
        if changed:
            self.flush(force=True)

    def touch(self):
        t, last = time.time(), self.last_activity
        self.last_activity = t
        self.dirty = True
        if last is None or t - last >= FLUSH_S:   # reprise après un silence : dite tout de suite, le worker allait peut-être
            self.flush(force=True)                 # mettre ComfyUI en veille sur une activité vieille de 5 s

    # ---- sonde : ComfyUI répond-il ? ----
    def probe(self, full):
        try:
            if not full:
                socket.create_connection(('127.0.0.1', self.backend), timeout=2).close()
                return True
            c = http.client.HTTPConnection('127.0.0.1', self.backend, timeout=5)
            try:
                c.request('GET', '/queue')
                return c.getresponse().status == 200
            finally:
                c.close()
        except (OSError, http.client.HTTPException):
            return False

    def watch(self):
        """Fil de la sonde : veille -> démarrage (un appel attend) -> actif (ComfyUI répond), et retour en veille."""
        while not self.stopping.is_set():
            self.kick.wait(self.probe_s if self.state != 'démarrage' else 0.5)
            self.kick.clear()
            alive = self.probe(full=not self.up.is_set())
            if alive and not self.up.is_set():
                self.up.set()
                self.attach_dormant()
                self.ready.set()
                self.set_state('actif')
            elif not alive and self.up.is_set():
                self.up.clear()
                self.ready.clear()
            if not alive:
                with self.lock:
                    waiting = self.waiters > 0
                    if waiting and self.state != 'démarrage':   # réveil demandé au worker (il lit ce fichier toutes les 3 s)
                        self.wake_at, self.wake_cause = time.time(), self.pending_cause
                        self.wakes += 1
                if waiting:
                    self.set_state('démarrage')
                else:
                    self.set_state('veille')
            self.flush()

    def attach_dormant(self):
        """Au réveil : chaque WebSocket gardé est branché sur ComfyUI avant que les appels HTTP passent."""
        with self.lock:
            todo = list(self.dormant)
        for d in todo:
            d.attach_now.set()
        deadline = time.time() + ATTACH_WAIT_S
        for d in todo:
            d.attached.wait(max(0.0, deadline - time.time()))

    def wait_ready(self, cause, beat=None):
        """Un appel attend ComfyUI : demande de réveil (dite au worker par le fichier d'état), attente au plus wait_s.
        beat : appelé toutes les heartbeat_s secondes d'attente (signe de vie au client) ; il rend False quand le client est parti.
        -> True (prêt), False (délai dépassé) ou None (client parti)."""
        if self.ready.is_set():
            return True
        with self.lock:
            self.waiters += 1
            if self.waiters == 1:
                self.pending_cause = cause[:200]
            self.dirty = True
        self.kick.set()
        try:
            deadline = time.time() + self.wait_s
            step = (self.heartbeat_s if self.heartbeat_s > 0 else 5.0) if beat else None   # heartbeat 0 : plus de 1xx, mais un client parti reste vu
            while True:
                left = deadline - time.time()
                if left <= 0:
                    return self.ready.is_set()
                if self.ready.wait(min(left, step) if step else left):
                    return True
                if step and not beat():
                    return None
        finally:
            with self.lock:
                self.waiters -= 1
                self.dirty = True
                last = self.waiters == 0
            if last:   # le worker ne met jamais en veille un ComfyUI qu'un appel attend : il doit voir 0 tout de suite
                self.flush(force=True)

    # ---- connexions ----
    def serve(self):
        socks = []
        for host in self.listen:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            # Windows : options par défaut, comme ComfyUI avant lui (adresse précise déjà tenue : refusée aux autres). Jamais
            # SO_EXCLUSIVEADDRUSE : un relais relancé (code, pare-feu, réglage) ne pourrait plus se lier au port tant que les
            # connexions acceptées par le précédent ne sont pas éteintes (doc Microsoft), et l'atelier passerait en repli.
            if os.name != 'nt':
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            for left in range(20, -1, -1):   # le précédent (relais ou ComfyUI) finit de se fermer : quelques secondes
                try:
                    s.bind((host, self.port))
                    break
                except OSError:
                    if not left:
                        raise
                    time.sleep(0.5)
            s.listen(64)
            socks.append(s)
        threading.Thread(target=self.watch, name='sonde', daemon=True).start()
        for s in socks:
            threading.Thread(target=self.accept_loop, args=(s,), name='écoute %s' % s.getsockname()[0], daemon=True).start()
        self.flush(force=True)
        while not self.stopping.wait(1):
            self.flush()

    def accept_loop(self, server):
        while not self.stopping.is_set():
            try:
                sock, addr = server.accept()
            except OSError:
                if self.stopping.is_set():
                    return
                time.sleep(0.2)
                continue
            if not peer_allowed(addr[0], self.allow):
                self.refused += 1
                self.dirty = True
                sock.close()
                continue
            threading.Thread(target=self.handle, args=(sock, addr[0]), daemon=True).start()

    def read_head(self, sock):
        sock.settimeout(HEAD_TIMEOUT_S)
        data = b''
        while b'\r\n\r\n' not in data:
            chunk = sock.recv(65536)
            if not chunk:
                return None
            data += chunk
            if len(data) > HEAD_MAX:
                raise ValueError('en-têtes trop longs')
        sock.settimeout(None)
        return data

    def connect_backend(self):
        u = socket.create_connection(('127.0.0.1', self.backend), timeout=10)
        u.settimeout(None)
        return u

    def handle(self, sock, peer):
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            data = self.read_head(sock)
            if data is None:
                sock.close()
                return
            method, target, headers = parse_head(data)
            version = data.split(b'\r\n', 1)[0].rsplit(b' ', 1)[-1].decode('latin-1')
        except (OSError, ValueError):
            sock.close()
            return
        self.connections += 1
        ws = is_websocket(headers)
        if ws and not self.ready.is_set():
            return self.keep_dormant(sock, data, headers)
        cause = '%s %s (%s)' % (method, target.split('?')[0][:120], peer)
        for _ in range(3):   # ComfyUI arrêté entre la sonde et la connexion : réveil, puis nouvel essai
            if ws and not self.ready.is_set():
                # ComfyUI vient d'être mis en veille (la sonde ne l'a pas encore vu) : l'onglet qui rouvre /ws 300 ms après
                # la coupure est gardé, comme pendant la veille ; sinon il le réveillerait à chaque mise en veille
                return self.keep_dormant(sock, data, headers)
            ok = self.wait_ready(cause, beat=None if ws else (lambda: send_interim(sock, version == 'HTTP/1.1' and self.heartbeat_s > 0)))
            if ok is None:   # le client a raccroché pendant l'attente
                sock.close()
                return
            if not ok:
                self.timeouts += 1
                self.dirty = True
                return answer(sock, 503, 'Service Unavailable', {
                    'error': 'atelier ComfyUI pas prêt après %d s : voir son état sur le hub (GET /api/reuse/workers/<nom>/atelier)' % self.wait_s})
            try:
                upstream = self.connect_backend()
                break
            except OSError:
                self.up.clear()
                self.ready.clear()
                self.kick.set()
        else:
            return answer(sock, 502, 'Bad Gateway', {'error': 'atelier ComfyUI injoignable après réveil'})
        if ws:
            self.count_ws(1)
            try:
                splice(sock, upstream, first=data)
            finally:
                self.count_ws(-1)
            return
        self.touch()
        splice(sock, upstream, on_bytes=self.touch, first=data)

    def keep_dormant(self, sock, head, headers):
        """WebSocket ouvert pendant la veille : poignée de main faite ici, connexion gardée sans réveiller ComfyUI."""
        key = headers.get('sec-websocket-key')
        with self.lock:
            full = len(self.dormant) >= DORMANT_MAX
        if not key or full:
            return answer(sock, 503, 'Service Unavailable', {'error': 'atelier ComfyUI en veille'})
        d = Dormant(sock, without_header(head, 'Sec-WebSocket-Extensions'))
        try:
            sock.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                          'Sec-WebSocket-Accept: %s\r\n\r\n' % ws_accept(key)).encode('latin-1'))
        except OSError:
            sock.close()
            return
        with self.lock:
            self.dormant.append(d)
            self.dirty = True
        self.flush(force=True)
        try:
            upstream = d.run(self)
        finally:
            with self.lock:
                if d in self.dormant:
                    self.dormant.remove(d)
                self.dirty = True
            d.attached.set()
        if upstream is None:
            return
        self.count_ws(1)
        try:
            splice(sock, upstream, first=d.buffer)
        finally:
            self.count_ws(-1)

    def count_ws(self, delta):
        """WebSockets branchés sur ComfyUI (rare : écrit tout de suite)."""
        with self.lock:
            self.ws_open += delta
            self.dirty = True
        self.flush(force=True)


class Dormant:
    def __init__(self, sock, head):
        self.sock, self.head, self.buffer = sock, head, b''
        self.attach_now = threading.Event()
        self.attached = threading.Event()

    def run(self, relay):
        """Attend le réveil en gardant ce que le client envoie. -> socket de ComfyUI branchée (réponse 101 lue), ou None."""
        while not relay.stopping.is_set():
            if self.attach_now.is_set() or relay.ready.is_set():
                return self.attach(relay)
            ready, _, _ = select.select([self.sock], [], [], 0.25)
            if ready:
                try:
                    data = self.sock.recv(65536)
                except OSError:
                    data = b''
                if not data or len(self.buffer) + len(data) > DORMANT_BUFFER:
                    self.sock.close()
                    return None
                self.buffer += data
        self.sock.close()
        return None

    def attach(self, relay):
        try:
            u = relay.connect_backend()
            u.sendall(self.head)
            u.settimeout(10)
            got = b''
            while b'\r\n\r\n' not in got:
                chunk = u.recv(4096)
                if not chunk:
                    raise OSError('fermé')
                got += chunk
                if len(got) > HEAD_MAX:
                    raise OSError('réponse trop longue')
            u.settimeout(None)
            head, _, rest = got.partition(b'\r\n\r\n')
            if b' 101 ' not in head.split(b'\r\n', 1)[0] + b' ':
                raise OSError('ComfyUI refuse le WebSocket : %r' % head[:80])
            if rest:   # premier message de ComfyUI (status) arrivé avec la réponse
                self.sock.sendall(rest)
            self.attached.set()
            return u
        except OSError:
            self.sock.close()
            self.attached.set()
            return None


def main(argv=None):
    p = argparse.ArgumentParser(description='Relais de l\'atelier ComfyUI (veille et réveil à la demande)')
    p.add_argument('--listen', required=True, help='adresses, séparées par des virgules (jamais 0.0.0.0)')
    p.add_argument('--port', type=int, required=True)
    p.add_argument('--backend', type=int, required=True, help='port de ComfyUI sur 127.0.0.1')
    p.add_argument('--state', required=True, help='fichier d\'état lu par le worker')
    p.add_argument('--allow', default='', help='adresses distantes permises en plus de la boucle locale (vide : toutes)')
    p.add_argument('--wait', type=float, default=300.0, help='attente au plus d\'un ComfyUI prêt, en secondes')
    p.add_argument('--heartbeat', type=float, default=HEARTBEAT_S, help='secondes entre deux signes de vie à un appel HTTP qui attend (0 : aucun)')
    a = p.parse_args(argv)
    listen = [h.strip() for h in a.listen.split(',') if h.strip()]
    for h in listen:
        ip = ipaddress.ip_address(h)
        if ip.is_unspecified or ip.version != 4:
            sys.exit('adresse d\'écoute refusée : %s' % h)
    if a.backend == a.port:
        sys.exit('le port de ComfyUI doit différer de celui du relais')
    relay = Relay(listen, a.port, a.backend, a.state, [x.strip() for x in a.allow.split(',') if x.strip()], a.wait, heartbeat_s=a.heartbeat)
    print('Relais de l\'atelier : %s port %d -> 127.0.0.1:%d (pid %d)' % (','.join(listen), a.port, a.backend, os.getpid()), flush=True)
    relay.serve()


if __name__ == '__main__':
    main()
