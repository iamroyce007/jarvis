import Foundation
import AVFoundation
import Speech
import CoreAudio

// JARVIS voice helper.
// On-device speech recognition (SFSpeechRecognizer) + native synthesis
// (AVSpeechSynthesizer) + RMS voice-activity detection.
// Protocol: newline-delimited JSON on stdin/stdout. Fully local, no network.

let stdoutQueue = DispatchQueue(label: "jarvis.stdout")

func emit(_ obj: [String: Any]) {
    stdoutQueue.async {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line)
        fflush(stdout)
    }
}

final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    private var voice: AVSpeechSynthesisVoice?
    private var rate: Float = 0.52
    private var volume: Float = 1.0
    private var currentId: String?
    // AVSpeechSynthesizer reports didFinish rather than didCancel on some macOS
    // builds, so cancellation is tracked explicitly. The TTS queue relies on
    // this to know whether to advance or drop pending sentences.
    private var stopping = false

    override init() {
        super.init()
        synth.delegate = self
    }

    var isSpeaking: Bool { synth.isSpeaking }

    func configure(voiceName: String?, rate: Float?, volume: Float?) {
        if let r = rate { self.rate = r }
        if let v = volume { self.volume = v }
        if let name = voiceName, !name.isEmpty {
            let all = AVSpeechSynthesisVoice.speechVoices()
            self.voice = all.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
                ?? all.first { $0.identifier == name }
                ?? self.voice
        }
    }

    func speak(_ text: String, id: String) {
        let utt = AVSpeechUtterance(string: text)
        utt.rate = rate
        utt.volume = volume
        utt.preUtteranceDelay = 0
        utt.postUtteranceDelay = 0
        if let v = voice { utt.voice = v }
        currentId = id
        stopping = false
        synth.speak(utt)
    }

    /// Barge-in: cut speech off immediately, dropping anything queued.
    func stop() {
        if synth.isSpeaking || synth.isPaused {
            stopping = true
            synth.stopSpeaking(at: .immediate)
        }
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        emit(["type": "tts_start", "id": currentId ?? ""])
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        emit(["type": "tts_end", "id": currentId ?? "", "cancelled": stopping])
        stopping = false
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        emit(["type": "tts_end", "id": currentId ?? "", "cancelled": true])
        stopping = false
    }
}

/// Chooses the microphone to capture from.
///
/// Opening a Bluetooth mic drops AirPods from A2DP into the HFP headset profile
/// — mono, 16 kHz — which audibly degrades anything playing. A built-in mic is
/// therefore preferred when one exists. But some Macs (the Mac mini, for one)
/// have no built-in mic at all, and virtual inputs from conferencing apps
/// report channels while delivering silence. Picking one of those leaves JARVIS
/// deaf, so anything not backed by real hardware is skipped and the user's own
/// default input is the fallback.
func preferredInputDevice() -> (id: AudioDeviceID, name: String, isBuiltIn: Bool)? {
    var size = UInt32(0)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)

    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }

    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var devices = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &devices) == noErr else { return nil }

    func inputChannels(_ dev: AudioDeviceID) -> Int {
        var a = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var sz = UInt32(0)
        guard AudioObjectGetPropertyDataSize(dev, &a, 0, nil, &sz) == noErr, sz > 0 else { return 0 }
        let buf = UnsafeMutableRawPointer.allocate(byteCount: Int(sz), alignment: 16)
        defer { buf.deallocate() }
        guard AudioObjectGetPropertyData(dev, &a, 0, nil, &sz, buf) == noErr else { return 0 }
        let list = buf.assumingMemoryBound(to: AudioBufferList.self)
        return Int(UnsafeMutableAudioBufferListPointer(list).reduce(0) { $0 + $1.mNumberChannels })
    }

    func transport(_ dev: AudioDeviceID) -> UInt32 {
        var a = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var t = UInt32(0)
        var sz = UInt32(MemoryLayout<UInt32>.size)
        AudioObjectGetPropertyData(dev, &a, 0, nil, &sz, &t)
        return t
    }

    func name(_ dev: AudioDeviceID) -> String {
        var a = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var cf: CFString = "" as CFString
        var sz = UInt32(MemoryLayout<CFString>.size)
        AudioObjectGetPropertyData(dev, &a, 0, nil, &sz, &cf)
        return cf as String
    }

    // Conferencing and routing tools install virtual inputs that advertise
    // channels but deliver silence, and they often report an ordinary transport
    // type, so they must be excluded by name as well.
    func isVirtualByName(_ n: String) -> Bool {
        let needles = ["teams", "zoom", "loopback", "blackhole", "soundflower",
                       "vb-cable", "vb cable", "krisp", "obs", "aggregate",
                       "multi-output", "virtual", "webex", "discord", "descript"]
        let lower = n.lowercased()
        return needles.contains { lower.contains($0) }
    }

    let inputs = devices.filter { inputChannels($0) > 0 && !isVirtualByName(name($0)) }

    // A real built-in mic is always the best choice: good enough for speech and
    // it leaves Bluetooth output untouched.
    if let builtIn = inputs.first(where: { transport($0) == kAudioDeviceTransportTypeBuiltIn }) {
        return (builtIn, name(builtIn), true)
    }

    // Otherwise honour whatever the user has selected as their input. Virtual
    // devices are never chosen automatically.
    var defAddr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var defaultDev = AudioDeviceID(0)
    var defSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                  &defAddr, 0, nil, &defSize, &defaultDev) == noErr,
       inputs.contains(defaultDev) {
        return (defaultDev, name(defaultDev), false)
    }

    // Last resort: any physical input.
    let physical = inputs.filter {
        let t = transport($0)
        return t != kAudioDeviceTransportTypeVirtual && t != kAudioDeviceTransportTypeAggregate
    }
    return (physical.first ?? inputs.first).map { ($0, name($0), false) }
}

final class Listener {
    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    private var running = false
    private var speechActive = false
    private var silenceFrames = 0
    private var voiceFrames = 0
    private var lastPartial = ""
    private var rearmToken = UUID()
    private var lastPartialAt = Date.distantPast
    /// How long the transcript may stall before the utterance is closed.
    ///
    /// People pause mid-sentence — to think, to breathe, to find a word. At
    /// 0.75s a single request was routinely chopped into two turns ("Pull me
    /// information" / "About Osama bin Laden"), which reads as terrible
    /// recognition even when every word was transcribed correctly. 1.4s is
    /// long enough to ride through a natural pause and still feel responsive.
    private var endpointSilence: TimeInterval = 1.4
    private var currentLocale = "en-IN"
    /// Consecutive transient engine-start failures, for backoff.
    private var startAttempts = 0

    /// Apple's on-device model is markedly less accurate than the server one,
    /// especially for names and non-US accents. Off by default; the caller
    /// decides whether accuracy or strict locality matters more.
    var forceOnDevice = false
    /// Names, apps and commands the recognizer should bias toward.
    var contextualStrings: [String] = []

    // VAD tuning. Frames arrive at roughly 10-20ms depending on buffer size.
    private var threshold: Float = 0.012
    private var silenceFramesToEnd = 45
    private var voiceFramesToStart = 3
    private var noiseFloor: Float = 0.004

    private func name(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    /// Reports the current status immediately, then requests if undetermined.
    /// Without an app bundle the TCC callback may never fire, so nothing is
    /// allowed to block on it.
    func requestAuth(_ done: @escaping (Bool, String) -> Void) {
        let current = SFSpeechRecognizer.authorizationStatus()
        done(current == .authorized, name(current))
        guard current == .notDetermined else { return }

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard let self = self else { return }
            emit(["type": "auth", "ok": status == .authorized, "status": self.name(status)])
        }
    }

    func start(locale: String) {
        guard !running else { return }

        // The requested locale may have no installed model (a machine set to
        // en-IN has no en-US recognizer), so fall back through the system
        // locale and the recognizer's own default before giving up.
        var candidates = [locale]
        if let sys = Locale.current.identifier as String?, !candidates.contains(sys) {
            candidates.append(sys.replacingOccurrences(of: "_", with: "-"))
        }
        for extra in ["en-IN", "en-US", "en-GB"] where !candidates.contains(extra) {
            candidates.append(extra)
        }

        var chosen: SFSpeechRecognizer?
        for id in candidates {
            if let r = SFSpeechRecognizer(locale: Locale(identifier: id)), r.isAvailable {
                chosen = r
                if id != locale {
                    emit(["type": "warn", "where": "stt", "message": "Using locale \(id)"])
                }
                break
            }
        }
        guard let rec = chosen else {
            emit(["type": "error", "where": "stt",
                  "message": "No speech recognizer available. Tried: \(candidates.joined(separator: ", "))"])
            return
        }
        recognizer = rec

        let req = makeRequest(rec)
        request = req

        let input = engine.inputNode

        // Only override the input device when a real built-in mic exists, purely
        // to keep Bluetooth headphones out of mono headset mode.
        //
        // Pinning any *other* device is actively harmful: forcing the audio unit
        // onto a Bluetooth input bypasses the system route change, so macOS never
        // brings the headset profile up and the tap receives zero buffers — the
        // engine reports itself as running while hearing nothing. Everywhere else
        // the user's own default input is respected and left untouched.
        guard let dev = preferredInputDevice() else {
            emit(["type": "error", "where": "audio",
                  "message": "No microphone available. Connect one and JARVIS will pick it up."])
            running = false
            emit(["type": "listening", "value": false])
            return
        }

        if dev.isBuiltIn {
            do {
                try input.auAudioUnit.setDeviceID(dev.id)
            } catch {
                emit(["type": "warn", "where": "audio",
                      "message": "Could not pin input to \(dev.name): \(error.localizedDescription)"])
            }
        }
        emit(["type": "input_device", "name": dev.name])

        // A tap on the input node must use the node's *output* format — its input
        // format describes the raw hardware and produces a tap that silently
        // delivers no buffers. The guard below is what prevents the format
        // mismatch exception, which only arises when no real device is attached.
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            emit(["type": "error", "where": "audio",
                  "message": "Microphone reported an unusable format. Check Sound settings."])
            running = false
            emit(["type": "listening", "value": false])
            return
        }

        // Stop a running engine before re-tapping, but do NOT reset() it:
        // reset tears down the input node's negotiated format, after which the
        // next start fails with FormatNotSupported (-10868) on devices whose
        // hardware format differs from the default, such as Bluetooth mics.
        if engine.isRunning { engine.stop() }

        input.removeTap(onBus: 0)
        // Passing nil lets the engine use the node's own format at the moment the
        // tap is created. Handing it a format read a few lines earlier races with
        // device changes — plugging in AirPods between the read and the install
        // throws 'format mismatch', an Objective-C exception Swift cannot catch,
        // which killed the helper 14 times before this.
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
            guard let self = self else { return }
            self.request?.append(buffer)
            self.analyze(buffer)
        }

        task = rec.recognitionTask(with: req) { [weak self] result, error in
            self?.onRecognition(result, error)
        }

        // Connecting or removing an audio device reconfigures the engine and
        // silently stops the tap; restart so JARVIS does not go quietly deaf.
        NotificationCenter.default.removeObserver(self, name: .AVAudioEngineConfigurationChange, object: engine)
        NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            guard let self = self, self.running else { return }
            emit(["type": "warn", "where": "audio", "message": "Audio device changed; restarting capture."])
            let locale = self.currentLocale
            self.stop()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                self?.start(locale: locale)
            }
        }

        engine.prepare()
        do {
            try engine.start()
            running = true
            currentLocale = locale
            startAttempts = 0
            emit(["type": "listening", "value": true])
        } catch {
            // -10868 (kAudioUnitErr_FormatNotSupported) is normal while Bluetooth
            // headphones switch between A2DP and the headset profile: for a moment
            // the device advertises a format the engine will not accept. Waiting
            // for the route to settle fixes it, so this is retried rather than
            // reported as a dead microphone.
            let code = (error as NSError).code
            let transient = code == -10868 || code == -10851 || code == 561_017_449
            if transient && startAttempts < 5 {
                startAttempts += 1
                let delay = 0.4 * Double(startAttempts)
                emit(["type": "warn", "where": "stt",
                      "message": "Audio device busy (\(code)); retrying in \(String(format: "%.1f", delay))s."])
                engine.stop()
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.start(locale: locale)
                }
                return
            }
            startAttempts = 0
            emit(["type": "error", "where": "stt",
                  "message": "Audio engine failed (\(code)): \(error.localizedDescription)"])
            emit(["type": "listening", "value": false])
        }
    }

    /// RMS energy VAD with an adaptive noise floor.
    private func analyze(_ buffer: AVAudioPCMBuffer) {
        guard let ch = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }

        var sum: Float = 0
        for i in 0..<n { sum += ch[i] * ch[i] }
        let rms = (sum / Float(n)).squareRoot()

        emit(["type": "level", "rms": rms])

        let gate = max(threshold, noiseFloor * 3.0)

        // Endpoint on the transcript, not on loudness. A noisy Bluetooth mic
        // keeps RMS above the gate long after the speaker has stopped, which
        // added seconds of dead air before the turn was sent. Once words stop
        // arriving, the utterance is over.
        if !lastPartial.isEmpty, Date().timeIntervalSince(lastPartialAt) > endpointSilence {
            lastPartialAt = Date()
            if speechActive {
                speechActive = false
                emit(["type": "speech_end"])
            }
            request?.endAudio()
            return
        }

        if rms > gate {
            voiceFrames += 1
            silenceFrames = 0
            if !speechActive && voiceFrames >= voiceFramesToStart {
                speechActive = true
                emit(["type": "speech_start"])
            }
        } else {
            // Track ambient level only while nobody is talking.
            noiseFloor = noiseFloor * 0.995 + rms * 0.005
            voiceFrames = 0
            if speechActive {
                silenceFrames += 1
                if silenceFrames >= silenceFramesToEnd {
                    speechActive = false
                    silenceFrames = 0
                    emit(["type": "speech_end"])
                }
            }
        }
    }

    /// Close the current utterance so the recognizer emits a final result.
    /// Only the audio stream is ended: calling `finish()` here would tear the
    /// task down before it can deliver the transcription, yielding an empty
    /// final result. `lastPartial` is deliberately preserved as a fallback.
    func endUtterance() {
        request?.endAudio()
        speechActive = false
        silenceFrames = 0
        voiceFrames = 0
    }

    /// Builds a recognition request with the current accuracy settings.
    private func makeRequest(_ rec: SFSpeechRecognizer) -> SFSpeechAudioBufferRecognitionRequest {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // Server-side recognition handles accents, slang and proper nouns far
        // better. Only pinned on-device when explicitly requested.
        req.requiresOnDeviceRecognition = forceOnDevice && rec.supportsOnDeviceRecognition
        // Free-form beats .dictation for conversational speech and slang.
        req.taskHint = .unspecified
        req.addsPunctuation = true
        if !contextualStrings.isEmpty {
            req.contextualStrings = Array(contextualStrings.prefix(100))
        }
        return req
    }

    /// Shared handling for every recognition task.
    private func onRecognition(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
        if let result = result {
            let text = result.bestTranscription.formattedString
            if !text.isEmpty && text != lastPartial {
                lastPartial = text
                lastPartialAt = Date()
                emit(["type": "stt_partial", "text": text])
            }
            if result.isFinal {
                // The final payload is sometimes empty even when partials were
                // good, so fall back to the best partial we saw.
                let final = text.isEmpty ? lastPartial : text
                lastPartial = ""
                emit(["type": "stt_final", "text": final])
                // A finished task never yields more text. Recognition must be
                // rearmed here, or JARVIS goes permanently deaf while still
                // reporting speech activity from the VAD.
                rearm()
            }
        }
        if let error = error as NSError? {
            // Flush whatever we heard before the recognizer gave up.
            if !lastPartial.isEmpty {
                let salvaged = lastPartial
                lastPartial = ""
                emit(["type": "stt_final", "text": salvaged])
            }
            // 1110 = "no speech detected"; routine, not worth surfacing.
            if error.code != 1110 {
                emit(["type": "error", "where": "stt", "message": error.localizedDescription])
            }
            rearm()
        }
    }

    /// Starts a fresh recognition task on the existing audio engine.
    /// Debounced so a final result plus a trailing error cannot start two.
    private func rearm() {
        guard running, let rec = recognizer else { return }
        let token = UUID()
        rearmToken = token
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self = self, self.rearmToken == token, self.running else { return }

            self.request?.endAudio()
            self.task?.cancel()

            let req = self.makeRequest(rec)
            self.request = req
            self.lastPartial = ""
            self.task = rec.recognitionTask(with: req) { [weak self] r, e in
                self?.onRecognition(r, e)
            }
        }
    }

    /// Begin a fresh recognition pass without tearing down the audio engine.
    func cycle(locale: String) {
        guard running, let rec = recognizer else { return }

        // Retire the previous task outright; its final result has already been
        // delivered by the time a cycle is requested.
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        lastPartial = ""
        speechActive = false
        silenceFrames = 0
        voiceFrames = 0

        let req = makeRequest(rec)
        request = req
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            self?.onRecognition(result, error)
        }
    }

    func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        endUtterance()
        running = false
        emit(["type": "listening", "value": false])
    }

    func setVAD(threshold: Float?, silenceMs: Int?) {
        if let t = threshold { self.threshold = t }
        if let ms = silenceMs { self.silenceFramesToEnd = max(6, ms / 12) }
    }
}

// MARK: - Command loop

let speaker = Speaker()
let listener = Listener()
var locale = "en-US"

func handle(_ cmd: [String: Any]) {
    guard let op = cmd["op"] as? String else { return }

    switch op {
    case "bundleinfo":
        let b = Bundle.main
        emit([
            "type": "bundleinfo",
            "path": b.bundlePath,
            "id": b.bundleIdentifier ?? "<nil>",
            "hasSpeechKey": b.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil,
            "hasMicKey": b.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil
        ])

    case "auth":
        listener.requestAuth { ok, status in
            emit(["type": "auth", "ok": ok, "status": status])
        }

    case "listen_start":
        if let l = cmd["locale"] as? String { locale = l }
        listener.start(locale: locale)

    case "listen_stop":
        listener.stop()

    case "end_utterance":
        listener.endUtterance()

    case "cycle":
        listener.cycle(locale: locale)

    case "speak":
        let text = (cmd["text"] as? String) ?? ""
        let id = (cmd["id"] as? String) ?? UUID().uuidString
        if !text.isEmpty { speaker.speak(text, id: id) }

    case "stop_speaking":
        speaker.stop()

    case "configure":
        speaker.configure(
            voiceName: cmd["voice"] as? String,
            rate: (cmd["rate"] as? NSNumber)?.floatValue,
            volume: (cmd["volume"] as? NSNumber)?.floatValue
        )
        listener.setVAD(
            threshold: (cmd["vadThreshold"] as? NSNumber)?.floatValue,
            silenceMs: (cmd["vadSilenceMs"] as? NSNumber)?.intValue
        )
        if let onDevice = cmd["onDevice"] as? Bool { listener.forceOnDevice = onDevice }
        if let hints = cmd["contextualStrings"] as? [String] { listener.contextualStrings = hints }
        emit(["type": "configured"])

    case "voices":
        let voices = AVSpeechSynthesisVoice.speechVoices().map {
            ["name": $0.name, "id": $0.identifier, "lang": $0.language,
             "quality": $0.quality == .premium ? "premium" : ($0.quality == .enhanced ? "enhanced" : "default")]
        }
        emit(["type": "voices", "voices": voices])

    case "ping":
        emit(["type": "pong"])

    case "quit":
        listener.stop()
        speaker.stop()
        exit(0)

    default:
        emit(["type": "error", "where": "protocol", "message": "unknown op \(op)"])
    }
}

// Read newline-delimited JSON commands from stdin on a background thread.
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        guard !line.isEmpty, let data = line.data(using: .utf8) else { continue }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async { handle(obj) }
    }
    DispatchQueue.main.async {
        listener.stop()
        exit(0)
    }
}

emit(["type": "ready"])
RunLoop.main.run()
