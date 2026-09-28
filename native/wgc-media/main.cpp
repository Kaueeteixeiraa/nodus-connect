#define GST_USE_UNSTABLE_API
#include <gst/gst.h>
#include <gst/sdp/sdp.h>
#include <gst/webrtc/webrtc.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

static GstElement* peer = nullptr;
static GstElement* encoder = nullptr;
static GMainLoop* loop = nullptr;
static std::mutex outputMutex;
static std::atomic<unsigned long long> captured{0};
static std::atomic<unsigned long long> encoded{0};
static std::atomic<unsigned long long> rtpPackets{0};
static std::atomic<unsigned long long> rtpBytes{0};
static std::mutex timingMutex;
static std::map<GstClockTime, gint64> encoderInputs;
static GstSegment encoderInputSegment, encoderOutputSegment;
static unsigned long long encodeTimeUs = 0, encodeSamples = 0;
static std::vector<gint64> encodeIntervals;
static gboolean reportMedia(gpointer);

static void sendLine(const std::string& line) {
  std::lock_guard<std::mutex> lock(outputMutex);
  std::cout << line << std::endl;
}

static std::string encode(const char* value) {
  gchar* result = g_base64_encode(reinterpret_cast<const guchar*>(value), std::strlen(value));
  std::string text(result);
  g_free(result);
  return text;
}

static void offerCreated(GstPromise* promise, gpointer) {
  if (gst_promise_wait(promise) != GST_PROMISE_RESULT_REPLIED) {
    sendLine("E offer-failed");
    gst_promise_unref(promise);
    return;
  }
  GstWebRTCSessionDescription* offer = nullptr;
  gst_structure_get(gst_promise_get_reply(promise), "offer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &offer, nullptr);
  gst_promise_unref(promise);
  if (!offer) { sendLine("E offer-empty"); return; }
  GstPromise* local = gst_promise_new();
  g_signal_emit_by_name(peer, "set-local-description", offer, local);
  gst_promise_interrupt(local);
  gst_promise_unref(local);
  gchar* sdp = gst_sdp_message_as_text(offer->sdp);
  sendLine("O " + encode(sdp));
  g_free(sdp);
  gst_webrtc_session_description_free(offer);
}

static void negotiationNeeded(GstElement*, gpointer) {
  GstPromise* promise = gst_promise_new_with_change_func(offerCreated, nullptr, nullptr);
  g_signal_emit_by_name(peer, "create-offer", nullptr, promise);
}

static void iceCandidate(GstElement*, guint index, gchar* candidate, gpointer) {
  sendLine("I " + std::to_string(index) + " " + encode(candidate));
}

static void connectionStateChanged(GObject* object, GParamSpec*, gpointer) {
  GstWebRTCPeerConnectionState state;
  g_object_get(object, "connection-state", &state, nullptr);
  if (state == GST_WEBRTC_PEER_CONNECTION_STATE_CONNECTED) sendLine("C connected");
  else if (state == GST_WEBRTC_PEER_CONNECTION_STATE_FAILED) sendLine("E webrtc-connection-failed");
}

struct Command { std::string line; };

static gboolean applyCommand(gpointer data) {
  std::unique_ptr<Command> command(static_cast<Command*>(data));
  std::istringstream input(command->line);
  char type = 0;
  input >> type;
  if (type == 'Q') { g_main_loop_quit(loop); return G_SOURCE_REMOVE; }
  if (type == 'T') {
    reportMedia(nullptr);
    return G_SOURCE_REMOVE;
  }
  if (type == 'Z') {
    std::lock_guard<std::mutex> lock(timingMutex);
    encodeIntervals.clear();
    return G_SOURCE_REMOVE;
  }
  if (type == 'B') {
    unsigned int bitrate = 0;
    input >> bitrate;
    if (bitrate >= 1000 && bitrate <= 50000) g_object_set(encoder, "bitrate", bitrate, nullptr);
    return G_SOURCE_REMOVE;
  }
  if (type == 'A') {
    std::string encoded;
    input >> encoded;
    gsize length = 0;
    guchar* bytes = g_base64_decode(encoded.c_str(), &length);
    GstSDPMessage* message = nullptr;
    if (gst_sdp_message_new(&message) == GST_SDP_OK && gst_sdp_message_parse_buffer(bytes, length, message) == GST_SDP_OK) {
      auto* answer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_ANSWER, message);
      GstPromise* promise = gst_promise_new();
      g_signal_emit_by_name(peer, "set-remote-description", answer, promise);
      gst_promise_interrupt(promise);
      gst_promise_unref(promise);
      gst_webrtc_session_description_free(answer);
      sendLine("A accepted");
    } else {
      if (message) gst_sdp_message_free(message);
      sendLine("E invalid-answer");
    }
    g_free(bytes);
  } else if (type == 'I') {
    unsigned int index = 0;
    std::string encoded;
    input >> index >> encoded;
    gsize length = 0;
    guchar* candidate = g_base64_decode(encoded.c_str(), &length);
    g_signal_emit_by_name(peer, "add-ice-candidate", index, candidate);
    g_free(candidate);
  }
  return G_SOURCE_REMOVE;
}

static gboolean busMessage(GstBus*, GstMessage* message, gpointer) {
  if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
    GError* error = nullptr;
    gchar* debug = nullptr;
    gst_message_parse_error(message, &error, &debug);
    sendLine("E " + std::string(error ? error->message : "pipeline-error"));
    if (error) g_error_free(error);
    g_free(debug);
    g_main_loop_quit(loop);
  }
  return G_SOURCE_CONTINUE;
}

static void sendPadDimensions(const char* prefix, GstPad* pad) {
  GstCaps* caps = gst_pad_get_current_caps(pad);
  int width = 0, height = 0;
  if (caps) {
    const GstStructure* structure = gst_caps_get_structure(caps, 0);
    gst_structure_get_int(structure, "width", &width);
    gst_structure_get_int(structure, "height", &height);
    gst_caps_unref(caps);
  }
  sendLine(std::string(prefix) + " " + std::to_string(width) + " " + std::to_string(height));
}

static GstPadProbeReturn countBuffer(GstPad* pad, GstPadProbeInfo* info, gpointer counter) {
  if (static_cast<std::atomic<unsigned long long>*>(counter) == &encoded && (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM)) {
    GstEvent* event = GST_PAD_PROBE_INFO_EVENT(info);
    if (GST_EVENT_TYPE(event) == GST_EVENT_SEGMENT) {
      const GstSegment* segment;
      gst_event_parse_segment(event, &segment);
      std::lock_guard<std::mutex> lock(timingMutex);
      encoderOutputSegment = *segment;
    }
    return GST_PAD_PROBE_OK;
  }
  if (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_BUFFER) {
    auto* value = static_cast<std::atomic<unsigned long long>*>(counter);
    if (value == &rtpPackets) {
      GstBuffer* buffer = GST_PAD_PROBE_INFO_BUFFER(info);
      rtpBytes.fetch_add(gst_buffer_get_size(buffer));
    }
    if (value == &encoded) {
      const GstClockTime pts = GST_BUFFER_PTS(GST_PAD_PROBE_INFO_BUFFER(info));
      std::lock_guard<std::mutex> lock(timingMutex);
      const GstClockTime running = gst_segment_to_running_time(&encoderOutputSegment, GST_FORMAT_TIME, pts);
      const auto entry = encoderInputs.find(running / GST_USECOND);
      if (entry != encoderInputs.end()) {
        const gint64 elapsed = g_get_monotonic_time() - entry->second;
        encodeTimeUs += elapsed;
        encodeSamples++;
        if (encodeIntervals.size() < 8192) encodeIntervals.push_back(elapsed);
        encoderInputs.erase(encoderInputs.begin(), std::next(entry));
      }
    }
    if (value->fetch_add(1) == 0) {
      if (value == &captured) {
        sendPadDimensions("V", pad);
        sendLine("R wgc no-cursor h264-hardware");
      }
    }
  }
  return GST_PAD_PROBE_OK;
}

static GstPadProbeReturn encoderInput(GstPad*, GstPadProbeInfo* info, gpointer) {
  if (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM) {
    GstEvent* event = GST_PAD_PROBE_INFO_EVENT(info);
    if (GST_EVENT_TYPE(event) == GST_EVENT_SEGMENT) {
      const GstSegment* segment;
      gst_event_parse_segment(event, &segment);
      std::lock_guard<std::mutex> lock(timingMutex);
      encoderInputSegment = *segment;
    }
    return GST_PAD_PROBE_OK;
  }
  const GstClockTime pts = GST_BUFFER_PTS(GST_PAD_PROBE_INFO_BUFFER(info));
  if (GST_CLOCK_TIME_IS_VALID(pts)) {
    std::lock_guard<std::mutex> lock(timingMutex);
    const GstClockTime running = gst_segment_to_running_time(&encoderInputSegment, GST_FORMAT_TIME, pts);
    if (GST_CLOCK_TIME_IS_VALID(running)) encoderInputs[running / GST_USECOND] = g_get_monotonic_time();
    if (encoderInputs.size() > 128) encoderInputs.erase(encoderInputs.begin());
  }
  return GST_PAD_PROBE_OK;
}

static void countOnSource(GstElement* pipeline, const char* name, std::atomic<unsigned long long>* counter) {
  GstElement* element = gst_bin_get_by_name(GST_BIN(pipeline), name);
  GstPad* pad = gst_element_get_static_pad(element, "src");
  const auto flags = static_cast<GstPadProbeType>(GST_PAD_PROBE_TYPE_BUFFER | (counter == &encoded ? GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM : 0));
  gst_pad_add_probe(pad, flags, countBuffer, counter, nullptr);
  gst_object_unref(pad);
  gst_object_unref(element);
}

static gboolean reportMedia(gpointer) {
  unsigned long long total, samples;
  std::vector<gint64> intervals;
  {
    std::lock_guard<std::mutex> lock(timingMutex);
    total = encodeTimeUs;
    samples = encodeSamples;
    intervals = encodeIntervals;
  }
  std::sort(intervals.begin(), intervals.end());
  const auto p95 = intervals.empty() ? 0 : intervals[(intervals.size() * 95 + 99) / 100 - 1];
  sendLine("M " + std::to_string(captured.load()) + " " + std::to_string(encoded.load()) + " " + std::to_string(rtpPackets.load()) + " " + std::to_string(rtpBytes.load()) + " " + std::to_string(total) + " " + std::to_string(samples) + " " + std::to_string(p95));
  return G_SOURCE_CONTINUE;
}

int main(int argc, char** argv) {
  gst_init(&argc, &argv);
  gst_segment_init(&encoderInputSegment, GST_FORMAT_TIME);
  gst_segment_init(&encoderOutputSegment, GST_FORMAT_TIME);
  encodeIntervals.reserve(8192);
  const int monitor = argc > 1 ? std::atoi(argv[1]) : -1;
  const int fps = argc > 2 ? std::atoi(argv[2]) : 60;
  const int bitrate = argc > 3 ? std::atoi(argv[3]) : 14000;
  const int width = argc > 4 ? std::atoi(argv[4]) : 0;
  const int height = argc > 5 ? std::atoi(argv[5]) : 0;
  const bool shareAudio = argc > 6 && std::atoi(argv[6]) == 1;
  std::string setup;
  if (!std::getline(std::cin, setup) || setup.rfind("S ", 0) != 0) return 1;
  const int serverCount = std::clamp(std::atoi(setup.c_str() + 2), 0, 72);
  std::vector<std::string> iceServers;
  for (int index = 0; index < serverCount; index++) {
    std::string uri;
    if (!std::getline(std::cin, uri) || uri.size() > 800) return 1;
    iceServers.push_back(uri);
  }
  const std::string dimensions = width > 0 && height > 0 ? ",width=" + std::to_string(width) + ",height=" + std::to_string(height) : "";
  const std::string pipeline =
    "webrtcbin name=pc bundle-policy=max-bundle "
    "d3d11screencapturesrc name=capture capture-api=wgc show-cursor=false monitor-index=" + std::to_string(monitor) +
    " ! video/x-raw(memory:D3D11Memory),framerate=" + std::to_string(fps) + "/1"
    " ! queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream"
    " ! d3d11convert ! video/x-raw(memory:D3D11Memory),format=NV12" + dimensions +
    " ! mfh264enc name=encoder low-latency=true bitrate=" + std::to_string(bitrate) +
    " ! video/x-h264,profile=baseline ! h264parse config-interval=-1"
    " ! rtph264pay name=pay config-interval=-1 aggregate-mode=zero-latency pt=96"
    " ! application/x-rtp,media=video,encoding-name=H264,payload=96 ! pc." +
    (shareAudio ? " wasapi2src loopback=true ! audioconvert ! audioresample ! opusenc ! rtpopuspay pt=97 ! application/x-rtp,media=audio,encoding-name=OPUS,payload=97 ! pc." : "");
  GError* error = nullptr;
  GstElement* media = gst_parse_launch(pipeline.c_str(), &error);
  if (!media || error) {
    sendLine("E " + std::string(error ? error->message : "pipeline-unavailable"));
    if (error) g_error_free(error);
    if (media) gst_object_unref(media);
    return 1;
  }
  peer = gst_bin_get_by_name(GST_BIN(media), "pc");
  encoder = gst_bin_get_by_name(GST_BIN(media), "encoder");
  GstElementFactory* factory = gst_element_get_factory(encoder);
  const char* implementation = gst_element_factory_get_metadata(factory, GST_ELEMENT_METADATA_LONGNAME);
  const char* classification = gst_element_factory_get_metadata(factory, GST_ELEMENT_METADATA_KLASS);
  sendLine("H " + encode(implementation ? implementation : "unknown") + " " + (classification && std::strstr(classification, "Hardware") ? "1" : "0"));
  GstPad* inputPad = gst_element_get_static_pad(encoder, "sink");
  gst_pad_add_probe(inputPad, static_cast<GstPadProbeType>(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM), encoderInput, nullptr, nullptr);
  gst_object_unref(inputPad);
  countOnSource(media, "capture", &captured);
  countOnSource(media, "encoder", &encoded);
  countOnSource(media, "pay", &rtpPackets);
  for (const auto& uri : iceServers) {
    if (uri.rfind("stun://", 0) == 0) g_object_set(peer, "stun-server", uri.c_str(), nullptr);
    else if (uri.rfind("turn://", 0) == 0 || uri.rfind("turns://", 0) == 0) {
      gboolean accepted = FALSE;
      g_signal_emit_by_name(peer, "add-turn-server", uri.c_str(), &accepted);
      if (!accepted) { sendLine("E turn-server-rejected"); return 1; }
    }
  }
  loop = g_main_loop_new(nullptr, FALSE);
  g_signal_connect(peer, "on-negotiation-needed", G_CALLBACK(negotiationNeeded), nullptr);
  g_signal_connect(peer, "on-ice-candidate", G_CALLBACK(iceCandidate), nullptr);
  g_signal_connect(peer, "notify::connection-state", G_CALLBACK(connectionStateChanged), nullptr);
  GstBus* bus = gst_element_get_bus(media);
  gst_bus_add_watch(bus, busMessage, nullptr);
  gst_object_unref(bus);
  if (gst_element_set_state(media, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
    sendLine("E pipeline-start-failed");
    return 1;
  }
  g_timeout_add_seconds(5, reportMedia, nullptr);
  std::thread reader([] {
    std::string line;
    while (std::getline(std::cin, line)) g_main_context_invoke(nullptr, applyCommand, new Command{line});
    g_main_context_invoke(nullptr, applyCommand, new Command{"Q"});
  });
  reader.detach();
  g_main_loop_run(loop);
  gst_element_set_state(media, GST_STATE_NULL);
  gst_object_unref(peer);
  gst_object_unref(encoder);
  gst_object_unref(media);
  g_main_loop_unref(loop);
  return 0;
}
