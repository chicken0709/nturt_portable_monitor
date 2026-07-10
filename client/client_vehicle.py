"""
NTURT CAN Data Client - Vehicle Side
====================================
This script runs on the vehicle's Raspberry Pi.
It reads CAN data from can0 and can1 and sends it to the remote server, or replays CSV files.
"""

import os
import json
import time
import asyncio
import websockets

from can_engine import CANEngine
from csv_engine import CSVEngine

# Configuration
# SERVER_URL = "ws://140.112.16.226:8889"  # modify this to your server's IP address or hostname
SERVER_URL = "ws://localhost:8889"
RECONNECT_DELAY = 5     # reconnection delay (second)
HEARTBEAT_INTERVAL = 1  # heartbeat interval (second)
BATCH_SIZE = 50         # batch size for sending messages (increase to improve efficiency)
BATCH_TIMEOUT = 0.05    # batch send timeout (second)
MAX_QUEUE_SIZE = 1000   # maximum queue size to prevent memory overflow
USE_BATCH_MODE = True   # batch sending mode

class CANDataClient:
    def __init__(self, server_url):
        self.server_url = server_url
        self.websocket = None
        
        self.running = True
        self.mode = 'realtime'        # 'realtime' or 'csv' or 'idle'
        
        # message queue and statistics
        self.message_count = 0
        self.message_queue = asyncio.Queue(maxsize=MAX_QUEUE_SIZE)
        self.dropped_messages = 0
        self.sent_batches = 0
        self.last_send_report = time.time()
        
        # duplicate messages filtering
        self.total_can_received = 0   
        self.filtered_duplicates = 0  
        self.latest_messages = {}     # key: (bus_id, can_id), value: message_data

        # initialize CAN engine
        self.can_engine = CANEngine(self)

        # initialize CSV engine
        self.csv_engine = CSVEngine(self)

        # command handlers mapping
        self.command_handler = {
            'switch_realtime': self.handle_switch_realtime,
            'request_csv_list': self.csv_engine.handle_request_csv_list,
            'select_csv': self.csv_engine.handle_select_csv,
            'csv_pause': self.csv_engine.handle_csv_pause,
            'csv_jump_percentage': self.csv_engine.handle_csv_jump_percentage,
            'csv_jump_time': self.csv_engine.handle_csv_jump_time,
            'csv_set_speed': self.csv_engine.handle_csv_set_speed,
            'csv_restart': self.csv_engine.handle_csv_restart
        }

    async def run(self):
        # main run loop
        print("Starting CAN Data Client...")
        
        # initialize CAN buses
        self.can_engine.start()
        
        while self.running:
            if await self.connect():
                try:
                    async with asyncio.TaskGroup() as tg:
                        # start all workers
                        t1 = tg.create_task(self.can_engine.read_can_bus(0))
                        t2 = tg.create_task(self.can_engine.read_can_bus(1))
                        t3 = tg.create_task(self.batch_sender())
                        t4 = tg.create_task(self.heartbeat_loop())
                        t5 = tg.create_task(self.csv_engine.csv_player())
                        
                        # if command_receiver returns (connection loss) or 
                        # one of the above tasks raises an exception, TaskGroup will 
                        # automatically terminate all tasks and exit the block
                        await self.command_receiver()

                        for task in [t1, t2, t3, t4, t5]: 
                            task.cancel() # Ensure all tasks are cancelled if command_receiver exits

                except (websockets.exceptions.ConnectionClosed, Exception) as e:
                    print(f"📡 Connection lost or Error: {e}")
                finally:
                    if self.websocket:
                        try:
                            await self.websocket.close()
                        except Exception:
                            pass
                    self.websocket = None
                    self.cleanup() 
                    await asyncio.sleep(0.05) 
                    
                print(f"🔄 Reconnecting in {RECONNECT_DELAY}s...")
                await asyncio.sleep(RECONNECT_DELAY)
        
    async def connect(self):
        # connect to the server with reconnection logic
        while self.running:
            try:
                print(f"Connecting to server at {self.server_url}...")
                self.websocket = await websockets.connect(
                    self.server_url,
                    ping_interval=20,
                    ping_timeout=10
                )
                print("Connected to server successfully!")
                return True
            except Exception as e:
                print(f"Failed to connect to server: {e}")
                print(f"Retrying in {RECONNECT_DELAY} seconds...")
                await asyncio.sleep(RECONNECT_DELAY)
        return False
    
    async def enqueue_can_message(self, can_id, data, bus_id):
        # enqueue CAN message for sending, with duplication filtering for realtime mode
        self.total_can_received += 1
        if not self.websocket: return False

        message_data = {
            'bus_id': bus_id, 'can_id': can_id, 
            'data': list(data), 'timestamp': time.time()
        }

        # duplication filtering
        if self.mode != 'csv':
            key = (bus_id, can_id)
            cached = self.latest_messages.get(key)
            if cached and cached['data'] == message_data['data']:
                self.filtered_duplicates += 1
                cached['timestamp'] = message_data['timestamp']
                return True
            self.latest_messages[key] = message_data

        try:
            self.message_queue.put_nowait(message_data)
            return True
        except asyncio.QueueFull:
            self.dropped_messages += 1
            if self.dropped_messages % 100 == 0:
                print(f"Warning: Queue full ({self.message_queue.qsize()}), data cached. Delayed: {self.dropped_messages}")
            return False

    async def batch_sender(self):
        # send batched messages to the server
        print("✅ Connected - Starting batch sender")

        try: 
            while self.running:
                batch = []
                # wait for at least one message to avoid spin-loop
                msg = await self.message_queue.get()
                batch.append(msg)

                # pull remaining messages up to BATCH_SIZE or until queue is empty
                while len(batch) < BATCH_SIZE and not self.message_queue.empty():
                    batch.append(self.message_queue.get_nowait())

                # send the batch
                if self.websocket and batch:
                    
                    await self.websocket.send(json.dumps({
                        'type': 'can_batch', 
                        'messages': batch, 
                        'count': len(batch)
                    }))
                    self.message_count += len(batch)
                    self.sent_batches += 1

                    # print stastics periodically
                    if time.time() - self.last_send_report > 5:
                        filter_rate = 0
                        if self.total_can_received > 0:
                            filter_rate = (self.filtered_duplicates / self.total_can_received) * 100
                        print(f"📊 Sent: {self.message_count} msgs | Received: {self.total_can_received} | Filtered: {filter_rate:.1f}% | Queue: {self.message_queue.qsize()}")
                        self.last_send_report = time.time()

                # small yield to prevent CPU hogging if BATCH_SIZE is 1
                if BATCH_SIZE == 1:
                    await asyncio.sleep(BATCH_TIMEOUT)
        except (websockets.exceptions.ConnectionClosed, websockets.exceptions.WebSocketException):
            print("⚠️ Batch sender stopped - waiting for reconnection")
        except Exception as e:
            print(f"Error in batch sender: {e}")
        finally:
            self.cleanup()
            await asyncio.sleep(0.05)

    async def send_heartbeat(self):
        # send heartbeat message to the server
        if not self.websocket:
            return
        
        try:
            filter_rate = 0
            if self.total_can_received > 0:
                filter_rate = (self.filtered_duplicates / self.total_can_received) * 100
            
            heartbeat_data = {
                'type': 'heartbeat',
                'timestamp': time.time(),
                'message_count': self.message_count,
                'dropped_messages': self.dropped_messages,
                'queue_size': self.message_queue.qsize(),
                'total_received': self.total_can_received,
                'filtered': self.filtered_duplicates,
                'filter_rate': f"{filter_rate:.1f}%",
                'mode': self.mode,
                'csv_file': os.path.basename(self.csv_engine.csv_file) if self.csv_engine.csv_file else None,
                'csv_paused': self.csv_engine.csv_paused
            }
            await self.websocket.send(json.dumps(heartbeat_data))
        except (websockets.exceptions.ConnectionClosed, websockets.exceptions.WebSocketException):
            # Connection closed, stop trying to send
            pass
        except Exception as e:
            print(f"Error sending heartbeat: {e}")

    async def heartbeat_loop(self):
        # heartbeat loop
        while self.running:
            try:
                if self.websocket:
                    await self.send_heartbeat()
                else:
                    # Connection lost, exit loop
                    break
                await asyncio.sleep(HEARTBEAT_INTERVAL)
            except asyncio.CancelledError:
                break
    
    async def command_receiver(self):
        # receive and process commands from the server
        while self.running:
            try:
                if not self.websocket:
                    await asyncio.sleep(0.1)
                    continue
                
                message = await self.websocket.recv()
                data = json.loads(message)
                
                cmd_type = data.get('type')
                print(f"📥 Received command: {cmd_type}")
                handler = self.command_handler.get(cmd_type)

                if handler:
                    await handler(data)
                else: 
                    print(f"⚠️ Unknown command type: {cmd_type}")
            except websockets.exceptions.ConnectionClosed:
                break
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"Error in command receiver: {e}")
                await asyncio.sleep(0.1)

    async def handle_switch_realtime(self, data):
        # swith to realtime mode
        print("Switching back to realtime mode")
        self.mode = 'realtime'

        # clear the message queue
        self.cleanup() 
        await asyncio.sleep(0.05) 
        
        await self.websocket.send(json.dumps({
            'type': 'mode_changed',
            'mode': 'realtime',
        }))
        
    def cleanup(self):
        # cleanup the message queue and cached messages
        flushed_count = 0
        # empty the queue
        while not self.message_queue.empty():
            try:
                self.message_queue.get_nowait()
                flushed_count += 1
            except asyncio.QueueEmpty:
                break

        # clear the cached messages
        self.latest_messages.clear()
        print(f"🧹 Flushed {flushed_count} messages.")
    
    def shutdown(self):
        # shutdown client
        print("Shutting down client...")
        self.running = False
        self.can_engine.shutdown()

async def main():
    # main function
    client = CANDataClient(SERVER_URL)
    
    try:
        await client.run()
    except KeyboardInterrupt:
        print("\nReceived shutdown signal")
    finally:
        client.shutdown()
        print("Client stopped")

if __name__ == "__main__":
    print("=" * 60)
    print("NTURT CAN Data Client - Vehicle Side")
    print("=" * 60)
    print(f"Server URL: {SERVER_URL}")
    print("Press Ctrl+C to stop")
    print("=" * 60)
    
    asyncio.run(main())