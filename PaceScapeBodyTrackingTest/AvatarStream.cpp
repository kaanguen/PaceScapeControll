#include "AvatarStream.h"

#include <cmath>
#include <iostream>
#include <limits>
#include <locale>
#include <sstream>
#include <string>

#define NOMINMAX
#include <windows.h>
#include <winhttp.h>

namespace
{
// Matches the 30 frames per second of the depth camera; the server applies the same transport limit.
constexpr auto poseInterval = std::chrono::milliseconds(33);
constexpr auto retryInterval = std::chrono::seconds(1);

std::string SerializePose(uint32_t bodyId, const k4abt_skeleton_t& skeleton)
{
    std::ostringstream json;
    json.imbue(std::locale::classic());
    json.precision(6);
    json << "{\"bodyId\":" << bodyId << ",\"rotations\":[";
    for (int joint = 0; joint < K4ABT_JOINT_COUNT; ++joint)
    {
        // Unity's quaternion order is x, y, z, w; the SDK stores w, x, y, z.
        const auto& q = skeleton.joints[joint].orientation.wxyz;
        json << (joint ? "," : "") << q.x << ',' << q.y << ',' << q.z << ',' << q.w;
    }
    json << "],\"confidence\":[";
    for (int joint = 0; joint < K4ABT_JOINT_COUNT; ++joint)
    {
        json << (joint ? "," : "") << static_cast<int>(skeleton.joints[joint].confidence_level);
    }
    json << "]}";
    return json.str();
}
}

struct AvatarStream::Connection
{
    HINTERNET session = nullptr;
    HINTERNET server = nullptr;

    Connection()
    {
        session = WinHttpOpen(L"PaceScapeBodyTrackingTest", WINHTTP_ACCESS_TYPE_NO_PROXY,
            WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (session && WinHttpSetTimeouts(session, 250, 250, 250, 250))
        {
            server = WinHttpConnect(session, L"127.0.0.1", 8787, 0);
        }
    }

    ~Connection()
    {
        if (server) WinHttpCloseHandle(server);
        if (session) WinHttpCloseHandle(session);
    }

    // Reuses the session so WinHTTP can keep the local connection alive at camera rate.
    bool Post(const std::string& body) const
    {
        if (!server)
        {
            return false;
        }

        HINTERNET request = WinHttpOpenRequest(server, L"POST", L"/api/body-tracking/pose", nullptr,
            WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
        if (!request)
        {
            return false;
        }

        DWORD disabledFeatures = WINHTTP_DISABLE_REDIRECTS;
        const auto size = static_cast<DWORD>(body.size());
        DWORD status = 0;
        DWORD statusSize = sizeof(status);
        const bool sent =
            WinHttpSetOption(request, WINHTTP_OPTION_DISABLE_FEATURE, &disabledFeatures, sizeof(disabledFeatures)) &&
            WinHttpSendRequest(request, L"Content-Type: application/json\r\n", static_cast<DWORD>(-1),
                const_cast<char*>(body.data()), size, size, 0) &&
            WinHttpReceiveResponse(request, nullptr) &&
            WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX) &&
            status == 204;
        WinHttpCloseHandle(request);
        return sent;
    }
};

AvatarStream::AvatarStream() : connection(std::make_shared<Connection>())
{
}

AvatarStream::~AvatarStream()
{
    if (pending.valid())
    {
        pending.wait();
    }
}

void AvatarStream::Publish(k4abt_frame_t frame)
{
    const auto now = std::chrono::steady_clock::now();
    if (now < nextPose || (pending.valid() && pending.wait_for(std::chrono::seconds(0)) != std::future_status::ready))
    {
        return;
    }
    if (pending.valid())
    {
        const bool sent = pending.get();
        if (sent != lastSendSucceeded)
        {
            std::cerr << (sent ? "Avatar pose stream connected.\n"
                               : "Avatar pose stream unavailable at http://127.0.0.1:8787. Retrying.\n");
        }
        lastSendSucceeded = sent;
    }

    // Follow the person closest to the camera, as in the Azure Kinect Unity sample.
    const auto bodyCount = k4abt_frame_get_num_bodies(frame);
    float closestDistance = std::numeric_limits<float>::infinity();
    uint32_t closestId = 0;
    k4abt_skeleton_t closest{};
    for (uint32_t index = 0; index < bodyCount; ++index)
    {
        k4abt_skeleton_t skeleton{};
        if (k4abt_frame_get_body_skeleton(frame, index, &skeleton) != K4A_RESULT_SUCCEEDED)
        {
            continue;
        }
        const auto& pelvis = skeleton.joints[K4ABT_JOINT_PELVIS].position.xyz;
        const float distance = std::sqrt(pelvis.x * pelvis.x + pelvis.y * pelvis.y + pelvis.z * pelvis.z);
        if (distance < closestDistance)
        {
            closestDistance = distance;
            closestId = k4abt_frame_get_body_id(frame, index);
            closest = skeleton;
        }
    }
    if (!std::isfinite(closestDistance))
    {
        return;
    }

    nextPose = now + (lastSendSucceeded ? poseInterval : retryInterval);
    pending = std::async(std::launch::async,
        [connection = connection, body = SerializePose(closestId, closest)] { return connection->Post(body); });
}
