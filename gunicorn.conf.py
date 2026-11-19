"""Socket.IO sessions and PTYs belong to one process. See docs/terminal-server.md."""
import os

bind = os.environ.get('MONITOR_BIND', '127.0.0.1:9998')
workers = 1
worker_class = 'geventwebsocket.gunicorn.workers.GeventWebSocketWorker'
timeout = 120
accesslog = '-'
errorlog = '-'
