import { resolveError } from "./errors";
import { clearLogs, getLogs, isLogEmpty, log } from "./logger";
import { endEpilogue, baAck, offlinebombFix, startPrologue, endPrologue } from "./payloads";
import { makeStartEpilogue, makeUnlockResponse } from "./solvers";
import { bufferToHexString } from "./utils";
import { startCountdown, CountdownController } from "./Countdown";

let bluetoothDevice: BluetoothDevice;
let txdCharacteristic: BluetoothRemoteGATTCharacteristic;
let rxdCharacteristic: BluetoothRemoteGATTCharacteristic;

let isStarted = false;

let autoReconnect = true;

let pendingStartEpilogue: NodeJS.Timeout; // workaround for determining new firmware, see handleRxdNotifications
let pendingTimeoutMessage: NodeJS.Timeout; // if we don't get a response in time, we should show an error message

let countdown: CountdownController; //prepare for the countdown

// I'm really sorry to have a DOM manipulation here, but this is the best way unless going down the rabbit hole of React (or any other frameworks you like)
// And... of course we had done that in the past (v0.x)
function updateUi(stage: "pending" | "ok" | "standby") {
  const mainButton = document.getElementById("main-button") as HTMLButtonElement;
  const deviceName = document.getElementById("device-name") as HTMLSpanElement;
  const counterElement = document.getElementById("counter") as HTMLElement;

  switch (stage) {
    case "pending":
      mainButton.innerText = "请稍候";
      mainButton.disabled = true;
      deviceName.innerText = "已连接：" + bluetoothDevice.name;
      break;
    case "ok":
      mainButton.innerText = "结束";
      mainButton.disabled = false;

      //start countdown
      countdown = startCountdown(420, counterElement, () => {
        console.log("时间到！");
      });

      break;
    case "standby":
      mainButton.innerText = "开启";
      mainButton.disabled = false;
      deviceName.innerText = "未连接";

      //countdown end
      countdown.stop();

      break;
  }
}

export async function disconnect() {
  if (bluetoothDevice) bluetoothDevice.gatt!.disconnect();
  isStarted = false;
  clearLogs();
  clearTimeout(pendingStartEpilogue);
  clearTimeout(pendingTimeoutMessage);
  updateUi("standby");

  //reconnect after 400ms
  if (autoReconnect) {
    setTimeout(() => {
      window.electronAPI.bluezclick();
    }, 400);
  }
}

async function handleBluetoothError(error: unknown) {
  // this is so fucking ugly but i have no choice
  // you would never know how those shitty browsers behave
  if (!error) throw error;

  const e = error.toString();

  if (e.match(/User cancelled/) || e == "2") {
    // "2" is a weird behavior of Bluefy browser on iOS
    return;
  }

  const dialogContent = document.getElementById("dialog-content") as HTMLParagraphElement;
  const dialogDebugContainer = document.getElementById("dialog-debug-container") as HTMLPreElement;
  const dialogDebugContent = document.getElementById("dialog-debug-content")!;

  const { output, isFatal, showLogs } = resolveError(error);
  output(dialogContent, error);

  dialogDebugContainer.style.display = "none";
  if (!isLogEmpty() && showLogs) {
    dialogDebugContainer.style.display = "block";
    dialogDebugContent.innerText = "调试信息：\n" + getLogs().join("\n");
  }

  const dialog = document.getElementById("dialog") as HTMLDialogElement;
  dialog.showModal(); // 显示对话框

  // 3秒后关闭对话框
  setTimeout(() => {
    dialog.close(); // 关闭对话框
  }, 3000);

  if (isFatal || autoReconnect)
    setTimeout(() => {
      disconnect();
    }, 3000);

  throw error;
}

async function handleRxdNotifications(event: Event) {
  const value = (event.target! as BluetoothRemoteGATTCharacteristic).value!;

  log("RXD: " + bufferToHexString(value.buffer));

  try {
    let payload = new Uint8Array(value.buffer);

    // due to a bug in the firmware, it may send an AT command "AT+STAS?" via RXD; it doesn't start with FDFD09
    if (payload[0] === 0x41 && payload[1] === 0x54 && payload[2] === 0x2b) {
      return;
    }

    if (payload[0] !== 0xfd && payload[0] !== 0x09) {
      throw new Error("WATERCTL INTERNAL Unknown RXD data");
    }

    // sometimes, the first one or two bytes are missing maybe due to bad firmware implementation
    // explanation: [0xFD, 0x09, ...] => [0xFD, 0xFD, 0x09, ...]
    if (payload[1] === 0x09) {
      payload = new Uint8Array([0xfd, ...payload]);
    }

    // explanation: [0x09, ...] => [0xFD, 0xFD, 0x09, ...]
    if (payload[0] === 0x09) {
      payload = new Uint8Array([0xfd, 0xfd, ...payload]);
    }

    // ... and sometimes it sends a single byte 0xFD
    if (payload.length < 4) {
      return;
    }

    const dType = payload[3];

    // https://github.com/prettier/prettier/issues/5158
    // prettier-ignore
    switch (dType) {
      case 0xB0: // start prologue ok; delay 500ms for key authentication request (AE) if this is a new firmware
      case 0xB1:
        clearTimeout(pendingStartEpilogue);
        pendingStartEpilogue = setTimeout(() => {
          txdCharacteristic.writeValue(makeStartEpilogue(bluetoothDevice.name!));
        }, 500);
        break;
      case 0xAE: // receiving an unlock request (AE), this is a new firmware
        clearTimeout(pendingStartEpilogue);
        await txdCharacteristic.writeValue(await makeUnlockResponse(payload, bluetoothDevice.name!));
        break;
      case 0xAF:
        switch (payload[5]) {
          case 0x55: // key authentication ok; continue to send start epilogue (B2)
            await txdCharacteristic.writeValue(makeStartEpilogue(bluetoothDevice.name!, true));
            break;
          case 0x01: // key authentication failed; "err41" (bad key)
          case 0x02: // ?
          case 0x04: // "err43" (bad nonce)
            throw new Error("WATERCTL INTERNAL Bad key");
          default:
            await txdCharacteristic.writeValue(makeStartEpilogue(bluetoothDevice.name!, true));
            throw new Error("WATERCTL INTERNAL Unknown RXD data");
        }
        break;
      case 0xB2: // start ok; update ui
        clearTimeout(pendingStartEpilogue);
        clearTimeout(pendingTimeoutMessage);
        isStarted = true;
        updateUi("ok");
        break;
      case 0xB3: // end prologue ok (B3); disconnect
        await txdCharacteristic.writeValue(endEpilogue);
        disconnect();
        break;
      case 0xAA: // telemetry, no need to respond
      case 0xB5: // temperature settings related, no need to respond
      case 0xB8: // unknown, no need to respond
        break;
      case 0xBA: // user info upload request; send BA ack to tell it we have done that (won't actually do it)
        await txdCharacteristic.writeValue(baAck);
        break;
      case 0xBC: // see offlinebombFix
        await txdCharacteristic.writeValue(offlinebombFix);
        break;
      case 0xC8: // start epilogue (B2) is refused
        throw new Error("WATERCTL INTERNAL Refused");
      default:
        throw new Error("WATERCTL INTERNAL Unknown RXD data");
    }
  } catch (error) {
    handleBluetoothError(error);
  }
}

function setupTimeoutMessage() {
  if (!pendingTimeoutMessage) {
    pendingTimeoutMessage = setTimeout(() => {
      handleBluetoothError("WATERCTL INTERNAL Operation timed out");
    }, 15000);
  }
}

function handleGattServerDisconnected() {
  console.log(`Device disconnected: ${bluetoothDevice.name}`);
  //location.reload();
  setTimeout(() => {
    disconnect();
  }, 800);
}

export async function start() {
  try {
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      // https://github.com/WebBluetoothCG/web-bluetooth/issues/234
      filters: Array.from("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ").map((c) => ({ namePrefix: c })),
      optionalServices: [window.navigator.userAgent.match(/Bluefy/) ? "generic_access" : 0xf1f0], // workaround for Bluefy
    });

    updateUi("pending");

    const server = await bluetoothDevice.gatt!.connect();
    const service = await server.getPrimaryService(0xf1f0);
    txdCharacteristic = await service.getCharacteristic(0xf1f1);
    rxdCharacteristic = await service.getCharacteristic(0xf1f2);

    await rxdCharacteristic.startNotifications();
    rxdCharacteristic.addEventListener("characteristicvaluechanged", handleRxdNotifications);

    await txdCharacteristic.writeValue(startPrologue);
    setupTimeoutMessage();

    bluetoothDevice.addEventListener("gattserverdisconnected", handleGattServerDisconnected);
  } catch (error) {
    handleBluetoothError(error);
  }
}

async function end() {
  try {
    await txdCharacteristic.writeValue(endPrologue);
    setupTimeoutMessage();
  } catch (error) {
    handleBluetoothError(error);
  }
}

export function handleButtonClick() {
  isStarted ? end() : start();
}

//与页面紧密相关，移植需改

// 类型声明
interface ElectronAPI {
  bluezclick: () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    mydisconnectDevice: Function;
  }
}

// 绑定到 window
window.mydisconnectDevice = async () => {
  autoReconnect = false;
  // 在需要移除监听器的时候
  // bluetoothDevice.removeEventListener("gattserverdisconnected", handleGattServerDisconnected);
  disconnect();
  // bluetoothDevice.gatt!.disconnect();
};

document.addEventListener("DOMContentLoaded", () => {
  setInterval(() => {
    if (autoReconnect) {
      const mainButton = document.getElementById("main-button") as HTMLButtonElement;
      if (mainButton.innerText== "开启") {
        window.electronAPI.bluezclick();
      }
    }
  }, 5000);
});
