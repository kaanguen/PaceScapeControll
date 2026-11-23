#pragma once

#include <chrono>
#include <future>
#include <memory>

#include <k4abt.h>

// Sends the 3D joint orientations of the closest tracked body to the local PaceScapeControll server,
// which relays them to the headset avatar while its body-tracking mirror mode is active.
class AvatarStream
{
public:
    AvatarStream();
    ~AvatarStream();
    AvatarStream(const AvatarStream&) = delete;
    AvatarStream& operator=(const AvatarStream&) = delete;

    void Publish(k4abt_frame_t frame);

private:
    struct Connection;
    std::shared_ptr<Connection> connection;
    std::chrono::steady_clock::time_point nextPose{};
    bool lastSendSucceeded = true;
    std::future<bool> pending;
};
