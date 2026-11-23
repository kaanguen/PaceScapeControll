#pragma once

#include <chrono>
#include <future>

#include <k4a/k4a.h>
#include <k4abt.h>

class DashboardStream
{
public:
    void Publish(k4abt_frame_t frame, const k4a_calibration_t& calibration);

private:
    std::chrono::steady_clock::time_point nextFrame{};
    bool lastSendSucceeded = true;
    std::future<bool> pending;
};
