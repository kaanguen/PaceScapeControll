#include "DashboardStream.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <locale>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#define NOMINMAX
#include <windows.h>
#include <winhttp.h>
#include <k4a/k4a.hpp>

#include <BodyTrackingHelpers.h>

namespace
{
constexpr size_t maxPacketSize = 2 * 1024 * 1024;
constexpr size_t maxMetadataSize = 32 * 1024;

struct HttpHandle
{
    HINTERNET value;
    ~HttpHandle()
    {
        if (value)
        {
            WinHttpCloseHandle(value);
        }
    }
};

bool PostFrame(std::vector<uint8_t> packet)
{
    const HttpHandle session{ WinHttpOpen(L"PaceScapeBodyTrackingTest", WINHTTP_ACCESS_TYPE_NO_PROXY,
                                          WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0) };
    if (!session.value || !WinHttpSetTimeouts(session.value, 250, 250, 250, 250))
    {
        return false;
    }

    const HttpHandle connection{ WinHttpConnect(session.value, L"127.0.0.1", 8787, 0) };
    if (!connection.value)
    {
        return false;
    }

    const HttpHandle request{ WinHttpOpenRequest(connection.value, L"POST", L"/api/body-tracking/frame",
        nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0) };
    DWORD disabledFeatures = WINHTTP_DISABLE_REDIRECTS;
    const auto size = static_cast<DWORD>(packet.size());
    if (!request.value ||
        !WinHttpSetOption(request.value, WINHTTP_OPTION_DISABLE_FEATURE, &disabledFeatures, sizeof(disabledFeatures)) ||
        !WinHttpSendRequest(request.value, L"Content-Type: application/octet-stream\r\n", static_cast<DWORD>(-1),
                            packet.data(), size, size, 0) ||
        !WinHttpReceiveResponse(request.value, nullptr))
    {
        return false;
    }

    DWORD status = 0;
    DWORD statusSize = sizeof(status);
    return WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX) && status == 204;
}

std::string ProjectSkeletons(k4abt_frame_t frame, const k4a_calibration_t& calibration,
    k4a_calibration_type_t targetCamera, int width, int height)
{
    std::ostringstream json;
    json.imbue(std::locale::classic());
    json.precision(std::numeric_limits<float>::max_digits10);
    json << '[';
    bool firstBody = true;
    const auto bodyCount = k4abt_frame_get_num_bodies(frame);
    for (uint32_t index = 0; index < bodyCount; ++index)
    {
        k4abt_skeleton_t skeleton{};
        if (k4abt_frame_get_body_skeleton(frame, index, &skeleton) != K4A_RESULT_SUCCEEDED)
        {
            continue;
        }

        std::array<k4a_float2_t, K4ABT_JOINT_COUNT> pixels{};
        std::array<bool, K4ABT_JOINT_COUNT> visible{};
        for (size_t joint = 0; joint < pixels.size(); ++joint)
        {
            const auto& sample = skeleton.joints[joint];
            if (sample.confidence_level < K4ABT_JOINT_CONFIDENCE_LOW)
            {
                continue;
            }
            int valid = 0;
            auto& pixel = pixels[joint];
            visible[joint] = k4a_calibration_3d_to_2d(&calibration, &sample.position,
                K4A_CALIBRATION_TYPE_DEPTH, targetCamera, &pixel, &valid) == K4A_RESULT_SUCCEEDED &&
                valid && std::isfinite(pixel.xy.x) && std::isfinite(pixel.xy.y) &&
                pixel.xy.x >= 0 && pixel.xy.x < width && pixel.xy.y >= 0 && pixel.xy.y < height;
        }

        if (!firstBody) json << ',';
        firstBody = false;
        json << '[' << k4abt_frame_get_body_id(frame, index) << ",[";
        bool firstBone = true;
        for (const auto& [start, end] : g_boneList)
        {
            if (!visible[start] || !visible[end])
            {
                continue;
            }
            if (!firstBone) json << ',';
            firstBone = false;
            const auto a = pixels[start].xy;
            const auto b = pixels[end].xy;
            json << '[' << a.x << ',' << a.y << ',' << b.x << ',' << b.y << ']';
        }
        json << "]]";
    }
    json << ']';
    return json.str();
}

// Zero means invalid. Map 0.5–5 m to byte values 255–1 for the dashboard preview.
void AppendDepthPreview(std::vector<uint8_t>& packet, const k4a::image& depth)
{
    constexpr int nearMm = 500;
    constexpr int farMm = 5000;
    const auto* buffer = depth.get_buffer();
    for (int y = 0; y < depth.get_height_pixels(); ++y)
    {
        const auto* row = reinterpret_cast<const uint16_t*>(buffer + static_cast<size_t>(y) * depth.get_stride_bytes());
        for (int x = 0; x < depth.get_width_pixels(); ++x)
        {
            const int mm = row[x];
            const int previewValue = 255 - (std::clamp(mm, nearMm, farMm) - nearMm) * 254 / (farMm - nearMm);
            packet.push_back(mm == 0 ? 0 : static_cast<uint8_t>(previewValue));
        }
    }
}
}

void DashboardStream::Publish(k4abt_frame_t frame, const k4a_calibration_t& calibration)
{
    const auto now = std::chrono::steady_clock::now();
    if (now < nextFrame || (pending.valid() && pending.wait_for(std::chrono::seconds(0)) != std::future_status::ready))
    {
        return;
    }
    if (pending.valid())
    {
        const bool sent = pending.get();
        if (sent != lastSendSucceeded)
        {
            std::cerr << (sent ? "Dashboard stream connected.\n" : "Dashboard stream unavailable at http://127.0.0.1:8787. Retrying.\n");
        }
        lastSendSucceeded = sent;
    }

    const k4a::capture capture(k4abt_frame_get_capture(frame));
    const auto color = capture.get_color_image();
    nextFrame = now + (lastSendSucceeded ? std::chrono::milliseconds(100) : std::chrono::seconds(1));
    if (!color || color.get_format() != K4A_IMAGE_FORMAT_COLOR_MJPG || color.get_size() >= maxPacketSize)
    {
        return;
    }

    const auto bodies = ProjectSkeletons(frame, calibration, K4A_CALIBRATION_TYPE_COLOR,
        color.get_width_pixels(), color.get_height_pixels());
    auto metadata = bodies;
    size_t depthBytes = 0;
    const auto depth = capture.get_depth_image();
    if (depth && depth.get_format() == K4A_IMAGE_FORMAT_DEPTH16)
    {
        const int width = depth.get_width_pixels();
        const int height = depth.get_height_pixels();
        const size_t previewBytes = static_cast<size_t>(width) * height;
        const auto depthBodies = ProjectSkeletons(frame, calibration, K4A_CALIBRATION_TYPE_DEPTH, width, height);
        const auto extendedMetadata = "{\"bodies\":" + bodies + ",\"depth\":[" +
            std::to_string(width) + ',' + std::to_string(height) + "],\"depthBodies\":" + depthBodies + '}';
        if (extendedMetadata.size() <= maxMetadataSize &&
            4 + extendedMetadata.size() + color.get_size() + previewBytes <= maxPacketSize)
        {
            metadata = extendedMetadata;
            depthBytes = previewBytes;
        }
    }
    const auto length = static_cast<uint32_t>(metadata.size());
    if (length > maxMetadataSize || length + 4 + color.get_size() > maxPacketSize)
    {
        return;
    }

    std::vector<uint8_t> packet;
    packet.reserve(4 + length + color.get_size() + depthBytes);
    for (int shift = 0; shift < 32; shift += 8)
    {
        packet.push_back(static_cast<uint8_t>(length >> shift));
    }
    packet.insert(packet.end(), metadata.begin(), metadata.end());
    packet.insert(packet.end(), color.get_buffer(), color.get_buffer() + color.get_size());
    if (depthBytes != 0)
    {
        AppendDepthPreview(packet, depth);
    }
    pending = std::async(std::launch::async, PostFrame, std::move(packet));
}
