"""
CAN Message Decoders for NTURT Remote Monitor
==============================================
This module contains all CAN message decoding functions.
"""

import time
import struct
import logging
import cantools
from datetime import datetime
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent
DBC_FILE = SERVER_DIR / "dbc" / "NTUR_EP6_260617.dbc"
XSENS_DBC_FILE = SERVER_DIR / "dbc" / "Xsens_MTi_600_series.dbc"

# CAN ID : (subsystem, handler_function_name, param_type)
# param_type: "raw" (data), "decoded" (decoded), "both" (data + decoded)
CAN_MESSAGE_CONFIG = { 
    # timestamp
    0x100: ("timestamp", "decode_timestamp", "decoded"),
    # vcu
    0x181: ("vcu", "decode_vcu_cockpit", "decoded"),
    0x281: ("vcu", "decode_vcu_status", "raw"),
    0x381: ("vcu", "decode_vcu_suspension", "decoded"),
    # gps
    0x400: ("gps", "decode_gps_basic", "decoded"),
    0x401: ("gps", "decode_gps_extended", "decoded"),
    # velocity
    0x402: ("velocity", "decode_velocity_x", "decoded"),
    0x403: ("velocity", "decode_velocity_y", "decoded"),
    0x404: ("velocity", "decode_velocity_z", "decoded"),
    0x405: ("velocity", "decode_angular_x", "decoded"),
    0x406: ("velocity", "decode_angular_y", "decoded"),
    0x407: ("velocity", "decode_angular_z", "decoded"),
    0x408: ("velocity", "decode_velocity_magnitude", "decoded"),
    0x440: ("distance", "decode_distance", "raw"),
    # accumulator
    0x601: ("accumulator", "decode_cell_voltage", "raw"),
    0x651: ("accumulator", "decode_accumulator_temperature", "raw"),
    0x710: ("accumulator", "decode_accumulator_heartbeat", "raw"),
    0x501: ("accumulator", "decode_accumulator_status", "raw"),
    0x511: ("accumulator", "decode_accumulator_state", "raw"),
    # inverter
    0x191: ("inverters", "decode_inverter_status", "both"),
    0x192: ("inverters", "decode_inverter_status", "both"),
    0x193: ("inverters", "decode_inverter_status", "both"),
    0x194: ("inverters", "decode_inverter_status", "both"),
    0x291: ("inverters", "decode_inverter_state", "decoded"),
    0x292: ("inverters", "decode_inverter_state", "decoded"),
    0x293: ("inverters", "decode_inverter_state", "decoded"),
    0x294: ("inverters", "decode_inverter_state", "decoded"),
    0x391: ("inverters", "decode_inverter_temperature", "decoded"),
    0x392: ("inverters", "decode_inverter_temperature", "decoded"),
    0x393: ("inverters", "decode_inverter_temperature", "decoded"),
    0x394: ("inverters", "decode_inverter_temperature", "decoded"),
    0x711: ("inverters", "decode_inverter_heartbeat", "raw"),
    0x712: ("inverters", "decode_inverter_heartbeat", "raw"),
    0x713: ("inverters", "decode_inverter_heartbeat", "raw"),
    0x714: ("inverters", "decode_inverter_heartbeat", "raw"),
    0x211: ("inverters", "decode_inverter_control", "raw"),
    0x212: ("inverters", "decode_inverter_control", "raw"),
    0x213: ("inverters", "decode_inverter_control", "raw"),
    0x214: ("inverters", "decode_inverter_control", "raw"),
    # imu
    0x185: ("imu", "decode_imu_accel_km6", "decoded"),
    0x426: ("imu", "decode_imu_accel_km308", "decoded"),
    0x285: ("imu", "decode_imu_gyro", "decoded"),
    0x385: ("imu", "decode_imu_euler", "decoded"),
    0x429: ("imu", "decode_imu_mag", "decoded"),
    # imu2
    0x188: ("imu2", "decode_imu2_accel", "decoded"),
    0x288: ("imu2", "decode_imu2_gyro", "decoded"),
    0x488: ("imu2", "decode_imu2_quaternion", "decoded"),
    # can logging
    0x421: ("logging", "decode_logging_status", "raw"),
    # tire temperature
    0x595: ("tire_temp", "decode_tire_temp", "raw"),
    0x596: ("tire_temp", "decode_tire_temp", "raw"),
    0x597: ("tire_temp", "decode_tire_temp", "raw"),
    0x598: ("tire_temp", "decode_tire_temp", "raw")
}

# VCU status bit flags
STATUS_FLAGS = {
    "STATE_READY": 1 << 0,
    "STATE_RTD_BLINK": 1 << 1,
    "STATE_RTD_STEADY": 1 << 2,
    "STATE_RTD_READY": 1 << 3,
    "STATE_RTD_SOUND": 1 << 4,
    "STATE_RUNNING": 1 << 5,
    "STATE_RUNNING_OK": 1 << 6,
    "STATE_RUNNING_ERROR": 1 << 7,
    "STATE_ERROR": 1 << 8
}

# suppress cantools warnings about overwriting messages when loading dbc
logging.getLogger("cantools").setLevel(logging.ERROR)

class CANDecoder:
    def __init__(self):
        # Data storage 
        self.data_store = self.create_empty_data_store()
        self.db = None
        self.xsens_db = None
        self.dbc_supported_can_id = set()
        self.xsens_supported_can_id = set()

        # load dbc file
        try:
            self.db = cantools.database.load_file(str(DBC_FILE), strict=False)
            self.dbc_supported_can_id = set(msg.frame_id for msg in self.db.messages)
            print(f"Loaded DBC file: {DBC_FILE}")
            print(f"Messages count: {len(self.db.messages)}")
        except Exception as e:
            print(f"Error loading DBC file: {e}")

        try:
            self.xsens_db = cantools.database.load_file(str(XSENS_DBC_FILE), strict=False)
            self.xsens_supported_can_id = set(msg.frame_id for msg in self.xsens_db.messages)
            print(f"Loaded Xsens DBC file: {XSENS_DBC_FILE}")
            print(f"Xsens messages count: {len(self.xsens_db.messages)}")
        except Exception as e:
            print(f"Error loading Xsens DBC file: {e}")

    def create_empty_data_store(self):
        return {
            'timestamp': {'time': None, 'last_update': None},
            'gps': {
                'lat': None, 'lon': None, 'alt': None, 'status': None,
                'last_update': None
            },
            'velocity': {
                'linear_x': None, 'linear_y': None, 'linear_z': None,
                'angular_x': None, 'angular_y': None, 'angular_z': None,
                'magnitude': None, 'speed_kmh': None,
                'last_update': None
            },
            'accumulator': {
                'soc': None, 'voltage': None, 'current': None, 'temperature': None,
                'status': None, 'heartbeat': None, 'capacity': None,
                'cell_voltages': [None] * 105, 'cell_temperatures': [None] * 224,
                'last_update': None
            },
            'inverters': {
                1: {'name': 'FL', 'status': None, 'torque': None, 'speed': None,
                    'control_word': None, 'target_torque': None,
                    'dc_voltage': None, 'dc_current': None,
                    'mos_temp': None, 'mcu_temp': None, 'motor_temp': None,
                    'heartbeat': None, 'last_update': None},
                2: {'name': 'FR', 'status': None, 'torque': None, 'speed': None,
                    'control_word': None, 'target_torque': None,
                    'dc_voltage': None, 'dc_current': None,
                    'mos_temp': None, 'mcu_temp': None, 'motor_temp': None,
                    'heartbeat': None, 'last_update': None},
                3: {'name': 'RL', 'status': None, 'torque': None, 'speed': None,
                    'control_word': None, 'target_torque': None,
                    'dc_voltage': None, 'dc_current': None,
                    'mos_temp': None, 'mcu_temp': None, 'motor_temp': None,
                    'heartbeat': None, 'last_update': None},
                4: {'name': 'RR', 'status': None, 'torque': None, 'speed': None,
                    'control_word': None, 'target_torque': None,
                    'dc_voltage': None, 'dc_current': None,
                    'mos_temp': None, 'mcu_temp': None, 'motor_temp': None,
                    'heartbeat': None, 'last_update': None}
            },
            'vcu': {
                'steer': None, 'accel': None, 'apps1': None,    
                'apps2': None, 'brake': None, 'bse1': None, 'bse2': None,
                'suspFL': None, 'suspFR': None, 'suspRL': None, 'suspRR': None,
                'status': None, 'gear': None,
                'last_update': None},
            'imu': {
                'accel_km6': {'x': None, 'y': None, 'z': None},
                'accel_km308': {'x': None, 'y': None, 'z': None},
                'gyro': {'x': None, 'y': None, 'z': None},
                'euler': {'roll': None, 'pitch': None, 'yaw': None},
                'mag': {'x': None, 'y': None, 'z': None},
                'last_update': None
            },
            'imu2': {
                'accel': {'x': None, 'y': None, 'z': None},
                'gyro': {'x': None, 'y': None, 'z': None},
                'quaternion': {'w': None, 'x': None, 'y': None, 'z': None},
                'last_update': None
            },
            'xsens': {
                'sample_time': {'timestamp_us': None},
                'group_counter': {'counter': None},
                'status_word': {
                    'self_test_ok': None, 'filter_valid': None, 'gnss_fix': None,
                    'no_rotation_status': None, 'representative_motion': None,
                    'external_clock_synced': None, 'clipping_detected': None,
                    'sync_in': None, 'sync_out': None, 'filter_mode': None,
                    'have_gnss_time_pulse': None, 'rtk_status': None,
                    'clip_acc_x': None, 'clip_acc_y': None, 'clip_acc_z': None,
                    'clip_gyr_x': None, 'clip_gyr_y': None, 'clip_gyr_z': None,
                    'clip_mag_x': None, 'clip_mag_y': None, 'clip_mag_z': None,
                },
                'quaternion': {'q0': None, 'q1': None, 'q2': None, 'q3': None},
                'euler': {'roll': None, 'pitch': None, 'yaw': None},
                'delta_v': {'x': None, 'y': None, 'z': None, 'exponent': None},
                'rate_of_turn': {'gyr_x': None, 'gyr_y': None, 'gyr_z': None},
                'delta_q': {'dq0': None, 'dq1': None, 'dq2': None, 'dq3': None},
                'acceleration': {'acc_x': None, 'acc_y': None, 'acc_z': None},
                'free_acceleration': {'x': None, 'y': None, 'z': None},
                'rate_of_turn_hr': {'gyr_x': None, 'gyr_y': None, 'gyr_z': None},
                'acceleration_hr': {'acc_x': None, 'acc_y': None, 'acc_z': None},
                'magnetic_field': {'mag_x': None, 'mag_y': None, 'mag_z': None},
                'temperature': {'temperature': None},
                'barometric_pressure': {'pressure': None},
                'utc': {
                    'year': None, 'month': None, 'day': None, 'hour': None,
                    'minute': None, 'second': None, 'tenth_ms': None,
                },
                'gps': {'lat': None, 'lon': None, 'alt': None},
                'position_ecef': {'x': None, 'y': None, 'z': None},
                'velocity': {'vel_x': None, 'vel_y': None, 'vel_z': None, 'speed_kmh': None},
                'gnss_status': {
                    'fix_type': None, 'num_sv': None, 'flags': None,
                    'valid': None, 'num_svs': None,
                },
                'gnss_dop': {'pdop': None, 'tdop': None, 'vdop': None, 'hdop': None},
                'warning': {'warning_code': None},
                'last_update': None,
            },
            'distance': {
                'trip_distance_km': None,
                'last_update': None
            },
            'logging': {
                'status': None,
                'start_time': None,
                'last_update': None
            },
            'tire_temp': {
                1: {'name': 'FL', 'cell_temperatures': [None] * 32, 'last_update': None},
                2: {'name': 'FR', 'cell_temperatures': [None] * 32, 'last_update': None},
                3: {'name': 'RL', 'cell_temperatures': [None] * 32, 'last_update': None},
                4: {'name': 'RR', 'cell_temperatures': [None] * 32, 'last_update': None}
            }
        }

    def reset_data_store(self):
        new_data_store = self.create_empty_data_store()
        self.data_store.clear()
        self.data_store.update(new_data_store)

    def get_broadcast_data(self, vehicle_clients, message_count, vehicle_connected, last_data_time):
        return {
            'timestamp': self.data_store['timestamp']['time'].isoformat() if self.data_store['timestamp']['time'] else None,
            'gps': self.data_store['gps'],
            'velocity': self.data_store['velocity'],
            'distance': self.data_store['distance'],
            'accumulator': self.data_store['accumulator'],
            'inverters': self.data_store['inverters'],
            'vcu': self.data_store['vcu'],
            'imu': self.data_store['imu'],
            'imu2': self.data_store['imu2'],
            'xsens': self.data_store['xsens'],
            'message_count': message_count,
            'update_time': datetime.now().isoformat(),
            'vehicle_clients': len(vehicle_clients),
            'vehicle_connected': vehicle_connected,
            'last_data_time': last_data_time,
            'logging': self.data_store['logging'],
            'tire_temp': self.data_store['tire_temp']
        }
        
    def decode_can_message(self, msg):
        can_id = msg.arbitration_id
        data = msg.data

        if self.decode_xsens_message(can_id, data):
            return

        if can_id not in CAN_MESSAGE_CONFIG:
            return
        
        subsystem, handler_name, param_type = CAN_MESSAGE_CONFIG[can_id]
        handler = getattr(self, handler_name)

        if can_id in self.dbc_supported_can_id and subsystem != "accumulator" and can_id != 0x281:
            message = self.db.get_message_by_frame_id(can_id)
            if len(data) < message.length:
                return
            try:
                decoded = message.decode(data)
            except Exception as e:
                print(f"DBC decoding error for CAN ID 0x{can_id:03X}: {e}")
                return

        try: 
            # decode messages based on subsystem and param_type
            if subsystem == "inverters":
                idx = can_id & 0xF
                if param_type == "raw":
                    handler(data, idx)
                elif param_type == "decoded":
                    handler(decoded, idx)
                elif param_type == "both":
                    handler(data, decoded, idx)
            elif subsystem == "tire_temp":
                idx = (can_id & 0xF) - 4
                handler(data, idx)
            else:
                if param_type == "raw":
                    handler(data)
                elif param_type == "decoded":
                    handler(decoded)
                elif param_type == "both":
                    handler(data, decoded)

            # update last_update time
            if subsystem is None:
                return
            if subsystem == 'inverters':
                idx = can_id & 0xF
                self.data_store[subsystem][idx]['last_update'] = time.time()
            elif subsystem == 'tire_temp':
                idx = (can_id & 0xF) - 4
                self.data_store[subsystem][idx]['last_update'] = time.time()
            else:
                self.data_store[subsystem]['last_update'] = time.time()
        
        except Exception as e:
            print(f"Failed to decode CAN message ID 0x{can_id:03X}: {e}")

    def decode_xsens_message(self, can_id, data):
        if self.xsens_db is None or can_id not in self.xsens_supported_can_id:
            return False

        message = self.xsens_db.get_message_by_frame_id(can_id)
        if len(data) < message.length:
            return True

        try:
            decoded = message.decode(data, decode_choices=False)
        except Exception as e:
            print(f"Xsens DBC decoding error for CAN ID 0x{can_id:03X}: {e}")
            return True

        try:
            self.apply_xsens_decoded_message(message.name, decoded)
            self.data_store['xsens']['last_update'] = time.time()
        except Exception as e:
            print(f"Failed to apply Xsens message ID 0x{can_id:03X}: {e}")
        return True

    def _set_xsens_values(self, section_name, decoded, mapping):
        section = self.data_store['xsens'][section_name]
        for target_key, signal_name in mapping.items():
            section[target_key] = decoded.get(signal_name)

    def _to_bool_or_none(self, value):
        if value is None:
            return None
        return bool(value)

    def apply_xsens_decoded_message(self, message_name, decoded):
        xsens = self.data_store['xsens']

        if message_name == 'Warning':
            xsens['warning']['warning_code'] = decoded.get('WarningCode')
        elif message_name == 'SampleTime':
            xsens['sample_time']['timestamp_us'] = decoded.get('Timestamp')
        elif message_name == 'GroupCounter':
            xsens['group_counter']['counter'] = decoded.get('Counter')
        elif message_name == 'StatusWord':
            bool_signals = {
                'self_test_ok': 'SelfTestOk',
                'filter_valid': 'FilterValid',
                'gnss_fix': 'GnssFix',
                'representative_motion': 'RepresentativeMotion',
                'external_clock_synced': 'ExternalClockSynced',
                'clipping_detected': 'ClippingDetected',
                'sync_in': 'SyncIn',
                'sync_out': 'SyncOut',
                'have_gnss_time_pulse': 'HaveGnssTimePulse',
                'clip_acc_x': 'ClipAccX',
                'clip_acc_y': 'ClipAccY',
                'clip_acc_z': 'ClipAccZ',
                'clip_gyr_x': 'ClipGyrX',
                'clip_gyr_y': 'ClipGyrY',
                'clip_gyr_z': 'ClipGyrZ',
                'clip_mag_x': 'ClipMagX',
                'clip_mag_y': 'ClipMagY',
                'clip_mag_z': 'ClipMagZ',
            }
            status = xsens['status_word']
            for target_key, signal_name in bool_signals.items():
                status[target_key] = self._to_bool_or_none(decoded.get(signal_name))
            status['no_rotation_status'] = decoded.get('NoRotationStatus')
            status['filter_mode'] = decoded.get('FilterMode')
            status['rtk_status'] = decoded.get('RtkStatus')
        elif message_name == 'Quaternion':
            self._set_xsens_values('quaternion', decoded, {
                'q0': 'Q0', 'q1': 'Q1', 'q2': 'Q2', 'q3': 'Q3',
            })
        elif message_name == 'EulerAngles':
            self._set_xsens_values('euler', decoded, {
                'roll': 'roll', 'pitch': 'pitch', 'yaw': 'yaw',
            })
        elif message_name == 'DeltaV':
            self._set_xsens_values('delta_v', decoded, {
                'x': 'X', 'y': 'Y', 'z': 'Z', 'exponent': 'Exponent',
            })
        elif message_name == 'RateOfTurn':
            self._set_xsens_values('rate_of_turn', decoded, {
                'gyr_x': 'gyrX', 'gyr_y': 'gyrY', 'gyr_z': 'gyrZ',
            })
        elif message_name == 'DeltaQ':
            self._set_xsens_values('delta_q', decoded, {
                'dq0': 'DeltaQ0', 'dq1': 'DeltaQ1', 'dq2': 'DeltaQ2', 'dq3': 'DeltaQ3',
            })
        elif message_name == 'Acceleration':
            self._set_xsens_values('acceleration', decoded, {
                'acc_x': 'accX', 'acc_y': 'accY', 'acc_z': 'accZ',
            })
        elif message_name == 'FreeAcceleration':
            self._set_xsens_values('free_acceleration', decoded, {
                'x': 'FreeAccX', 'y': 'FreeAccY', 'z': 'FreeAccZ',
            })
        elif message_name == 'RateOfTurnHR':
            self._set_xsens_values('rate_of_turn_hr', decoded, {
                'gyr_x': 'HrGyrX', 'gyr_y': 'HrGyrY', 'gyr_z': 'HrGyrZ',
            })
        elif message_name == 'AccelerationHR':
            self._set_xsens_values('acceleration_hr', decoded, {
                'acc_x': 'HrAccX', 'acc_y': 'HrAccY', 'acc_z': 'HrAccZ',
            })
        elif message_name == 'MagneticField':
            self._set_xsens_values('magnetic_field', decoded, {
                'mag_x': 'magX', 'mag_y': 'magY', 'mag_z': 'magZ',
            })
        elif message_name == 'Temperature':
            xsens['temperature']['temperature'] = decoded.get('Temperature')
        elif message_name == 'BarometricPressure':
            xsens['barometric_pressure']['pressure'] = decoded.get('Pressure')
        elif message_name == 'UTC':
            self._set_xsens_values('utc', decoded, {
                'year': 'year', 'month': 'month', 'day': 'day',
                'hour': 'hour', 'minute': 'minute', 'second': 'second',
                'tenth_ms': 'tenthms',
            })
        elif message_name == 'LatLon':
            self._set_xsens_values('gps', decoded, {
                'lat': 'latitude', 'lon': 'longitude',
            })
        elif message_name == 'AltitudeEllipsoid':
            xsens['gps']['alt'] = decoded.get('altEllipsoid')
        elif message_name == 'PositionEcef_X':
            xsens['position_ecef']['x'] = decoded.get('PositionEcef_X')
        elif message_name == 'PositionEcef_Y':
            xsens['position_ecef']['y'] = decoded.get('PositionEcef_Y')
        elif message_name == 'PositionEcef_Z':
            xsens['position_ecef']['z'] = decoded.get('PositionEcef_Z')
        elif message_name == 'Velocity':
            self._set_xsens_values('velocity', decoded, {
                'vel_x': 'velX', 'vel_y': 'velY', 'vel_z': 'velZ',
            })
            vel_x = xsens['velocity']['vel_x']
            vel_y = xsens['velocity']['vel_y']
            if vel_x is not None and vel_y is not None:
                xsens['velocity']['speed_kmh'] = ((vel_x ** 2 + vel_y ** 2) ** 0.5) * 3.6
        elif message_name == 'GnssReceiverStatus':
            self._set_xsens_values('gnss_status', decoded, {
                'fix_type': 'fixType', 'num_sv': 'numSv', 'flags': 'flags',
                'valid': 'valid', 'num_svs': 'numSvs',
            })
        elif message_name == 'GnssReceiverDop':
            self._set_xsens_values('gnss_dop', decoded, {
                'pdop': 'pdop', 'tdop': 'tdop', 'vdop': 'vdop', 'hdop': 'hdop',
            })

    # decode functions
    def decode_timestamp(self, decoded):
        ms_since_midnight = decoded.get('MillisecondsSinceMidnight')
        days_since_1984 = decoded.get('DaysSince1984')
            
        base_timestamp = 441763200
        total_seconds = base_timestamp + (days_since_1984 * 86400) + (ms_since_midnight / 1000.0)
        decoded_time = datetime.fromtimestamp(total_seconds)
        
        self.data_store['timestamp']['time'] = decoded_time

    def decode_vcu_cockpit(self, decoded):
        self.data_store['vcu']['steer'] = decoded.get('Steer')
        self.data_store['vcu']['accel'] = decoded.get('Accel')
        self.data_store['vcu']['apps1'] = decoded.get('APPS1')
        self.data_store['vcu']['apps2'] = decoded.get('APPS2')
        self.data_store['vcu']['brake'] = decoded.get('Brake')
        self.data_store['vcu']['bse1'] = decoded.get('BSE1')
        self.data_store['vcu']['bse2'] = decoded.get('BSE2')

    def decode_vcu_status(self, data):
        if len(data) < 2: return
        status = struct.unpack('<H', data[0:2])[0]
        gear = struct.unpack('<B', data[4:5])[0]

        self.data_store['vcu']['status'] = [statusName for statusName, flag in STATUS_FLAGS.items() if status & flag]
        self.data_store['vcu']['gear'] = gear

    def decode_vcu_suspension(self, decoded):
        self.data_store['vcu']['suspFL'] = decoded.get('SUSP_FL')
        self.data_store['vcu']['suspFR'] = decoded.get('SUSP_FR')
        self.data_store['vcu']['suspRL'] = decoded.get('SUSP_RL')
        self.data_store['vcu']['suspRR'] = decoded.get('SUSP_RR')

    def decode_gps_basic(self, decoded):
        self.data_store['gps']['lat'] = decoded.get('Latitude')
        self.data_store['gps']['lon'] = decoded.get('Longitude')

    def decode_gps_extended(self, decoded):
        self.data_store['gps']['alt'] = decoded.get('Altitude')
        self.data_store['gps']['status'] = decoded.get('Status')

    def decode_velocity_x(self, decoded):
        self.data_store['velocity']['linear_x'] = decoded.get('Vx')

    def decode_velocity_y(self, decoded):
        self.data_store['velocity']['linear_y'] = decoded.get('Vy')

    def decode_velocity_z(self, decoded):
        self.data_store['velocity']['linear_z'] = decoded.get('Vz')

    def decode_angular_x(self, decoded):
        self.data_store['velocity']['angular_x'] = decoded.get('Gx')

    def decode_angular_y(self, decoded):
        self.data_store['velocity']['angular_y'] = decoded.get('Gy')

    def decode_angular_z(self, decoded):
        self.data_store['velocity']['angular_z'] = decoded.get('Gz')

    def decode_velocity_magnitude(self, decoded):
        self.data_store['velocity']['magnitude'] = decoded.get('Velocity')
        self.data_store['velocity']['speed_kmh'] = decoded.get('Velocity') * 3.6

    def decode_distance(self, data):
        if len(data) >= 4:
            distance_mm = struct.unpack('<I', data[0:4])[0]
            self.data_store['distance']['trip_distance_km'] = distance_mm / 1000000.0

    def decode_cell_voltage(self, data):
        if len(data) >= 8:
            index = data[0]
            
            if index % 7 != 0 or index > 98:
                return
            
            voltages = []
            for i in range(1, min(8, len(data))):
                voltage = data[i] * 0.02
                voltages.append(voltage)
            
            for i, voltage in enumerate(voltages):
                array_index = index + i
                if array_index < 105:
                    self.data_store['accumulator']['cell_voltages'][array_index] = voltage
            
    def decode_accumulator_temperature(self, data):
        if len(data) >= 8:
            index = data[0]
            
            if index % 7 != 0 or index > 217:
                return
            
            temperatures = []
            for i in range(1, min(8, len(data))):
                temp = data[i] - 32  
                temperatures.append(temp)
            
            for i, temp in enumerate(temperatures):
                array_index = index + i
                if array_index < 224: 
                    self.data_store['accumulator']['cell_temperatures'][array_index] = temp

    def decode_accumulator_heartbeat(self, data):
        if len(data) >= 1:
            heartbeat = data[0] == 0x7F
            self.data_store['accumulator']['heartbeat'] = heartbeat

    def decode_accumulator_status(self, data):
        if len(data) >= 7:
            status = data[0]
            temperature_raw = struct.unpack('<h', data[1:3])[0]
            voltage_raw = struct.unpack('<I', data[3:7])[0] if len(data) >= 7 else 0
            
            self.data_store['accumulator']['status'] = status
            self.data_store['accumulator']['temperature'] = temperature_raw * 0.125
            self.data_store['accumulator']['voltage'] = voltage_raw / 1024.0

    def decode_accumulator_state(self, data):
        if len(data) >= 5:
            soc = data[0]
            current_raw = struct.unpack('<h', data[1:3])[0]
            capacity_raw = struct.unpack('<h', data[3:5])[0] if len(data) >= 5 else 0
            
            self.data_store['accumulator']['soc'] = soc
            self.data_store['accumulator']['current'] = current_raw * 0.01
            self.data_store['accumulator']['capacity'] = capacity_raw * 0.01

    def decode_inverter_status(self, data, decoded, inv_num):
        # status doesn't match with any dbc signal
        status_word1 = data[0]
        status_word2 = data[1]

        feedback_torque_raw = decoded.get('TorqueFeedback')
        speed_raw = decoded.get('Speed')

        feedback_torque = feedback_torque_raw / 100.0 * 20 * 4
        speed = speed_raw

        if inv_num == 2 or inv_num == 3:
            feedback_torque *= -1
        
        self.data_store['inverters'][inv_num]['status'] = (status_word1, status_word2) 
        self.data_store['inverters'][inv_num]['torque'] = feedback_torque
        self.data_store['inverters'][inv_num]['speed'] = speed

    def decode_inverter_state(self, decoded, inv_num):
        self.data_store['inverters'][inv_num]['dc_voltage'] = decoded.get('DCvolt')
        self.data_store['inverters'][inv_num]['dc_current'] = decoded.get('DCcurrent')

    def decode_inverter_temperature(self, decoded, inv_num):
        self.data_store['inverters'][inv_num]['mos_temp'] = decoded.get('InvMOStemp')
        self.data_store['inverters'][inv_num]['mcu_temp'] = decoded.get('MCUtemp')
        self.data_store['inverters'][inv_num]['motor_temp'] = decoded.get('MOTORtemp')

    def decode_inverter_heartbeat(self, data, inv_num):
        if len(data) >= 1:
            heartbeat = data[0] == 0x05
            self.data_store['inverters'][inv_num]['heartbeat'] = heartbeat

    def decode_inverter_control(self, data, inv_num):
        if len(data) >= 4:
            control_word = struct.unpack('<H', data[0:2])[0]
            target_torque_raw = struct.unpack('<h', data[2:4])[0]
            target_torque = target_torque_raw / 1000.0 * 20

            if inv_num == 2 or inv_num == 3:
                target_torque *= -1

            self.data_store['inverters'][inv_num]['control_word'] = control_word
            self.data_store['inverters'][inv_num]['target_torque'] = target_torque

    def decode_imu_accel_km6(self, decoded):
        self.data_store['imu']['accel_km6']['x'] = decoded.get('a_x')
        self.data_store['imu']['accel_km6']['y'] = decoded.get('a_y')
        self.data_store['imu']['accel_km6']['z'] = decoded.get('a_z')

    def decode_imu_accel_km308(self, decoded):
        self.data_store['imu']['accel_km308']['x'] = decoded.get('a_x')
        self.data_store['imu']['accel_km308']['y'] = decoded.get('a_y')
        self.data_store['imu']['accel_km308']['z'] = decoded.get('a_z')

    def decode_imu_gyro(self, decoded):
        self.data_store['imu']['gyro']['x'] = decoded.get('g_x')
        self.data_store['imu']['gyro']['y'] = decoded.get('g_y')
        self.data_store['imu']['gyro']['z'] = decoded.get('g_z')

    def decode_imu_euler(self, decoded):
        self.data_store['imu']['euler']['roll'] = decoded.get('roll')
        self.data_store['imu']['euler']['pitch'] = decoded.get('pitch')
        self.data_store['imu']['euler']['yaw'] = decoded.get('yaw')

    def decode_imu_mag(self, decoded):
        self.data_store['imu']['mag']['x'] = decoded.get('m_x')
        self.data_store['imu']['mag']['y'] = decoded.get('m_y')
        self.data_store['imu']['mag']['z'] = decoded.get('m_z')

    def decode_imu2_accel(self, decoded):
        self.data_store['imu2']['accel']['x'] = decoded.get('a_x_1')
        self.data_store['imu2']['accel']['y'] = decoded.get('a_y_1')
        self.data_store['imu2']['accel']['z'] = decoded.get('a_z_1')

    def decode_imu2_gyro(self, decoded):
        self.data_store['imu2']['gyro']['x'] = decoded.get('g_x_1')
        self.data_store['imu2']['gyro']['y'] = decoded.get('g_y_1')
        self.data_store['imu2']['gyro']['z'] = decoded.get('g_z_1')

    def decode_imu2_quaternion(self, decoded):
        self.data_store['imu2']['quaternion']['w'] = decoded.get('q_w')
        self.data_store['imu2']['quaternion']['x'] = decoded.get('q_x')
        self.data_store['imu2']['quaternion']['y'] = decoded.get('q_y')
        self.data_store['imu2']['quaternion']['z'] = decoded.get('q_z')

    def decode_logging_status(self, data):
        if len(data) >= 5:
            status = data[0]
            start_time = struct.unpack('<i', data[1:5])[0]
            
            self.data_store['logging']['status'] = status
            self.data_store['logging']['start_time'] = start_time

    def decode_tire_temp(self, data, idx):
        if len(data) >= 8:
            cell_index = data[0]
            temperatures = [data[i] for i in range(1, min(8, len(data)))]

            for i, temp in enumerate(temperatures):
                array_index = cell_index * 7 + i
                if array_index < 32:
                    self.data_store['tire_temp'][idx]['cell_temperatures'][array_index] = temp / 2
