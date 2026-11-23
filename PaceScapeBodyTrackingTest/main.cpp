// Adapted from the Azure Kinect simple_3d_viewer sample (MIT License).

#include <chrono>
#include <cstdint>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <dxgi.h>
#pragma comment(lib, "dxgi.lib")

#include <k4a/k4a.hpp>
#include <k4abt.h>

#include <Window3dWrapper.h>

#include "AvatarStream.h"
#include "DashboardStream.h"

namespace
{
struct ViewerState
{
    bool running = true;
    bool showJointAxes = false;
};

int64_t CloseViewer(void* context)
{
    static_cast<ViewerState*>(context)->running = false;
    return 1;
}

int64_t HandleKey(void* context, int key)
{
    auto& state = *static_cast<ViewerState*>(context);
    if (key == GLFW_KEY_ESCAPE)
    {
        return CloseViewer(context);
    }
    if (key == GLFW_KEY_B)
    {
        state.showJointAxes = !state.showJointAxes;
    }
    return 1;
}

void DestroyTracker(k4abt_tracker_t tracker)
{
    k4abt_tracker_shutdown(tracker);
    k4abt_tracker_destroy(tracker);
}

// DirectML uses the DXGI adapter index as gpu_device_id. On hybrid laptops index 0 is often the
// integrated GPU, which lowers the tracking rate; fast movements then show larger pose steps.
// Without an explicit index, the hardware adapter with the most dedicated video memory is used.
int SelectDirectMlAdapter(int requestedIndex)
{
    IDXGIFactory1* factory = nullptr;
    if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory))))
    {
        std::cerr << "GPU-Liste nicht verfuegbar, verwende GPU " << (requestedIndex >= 0 ? requestedIndex : 0) << ".\n";
        return requestedIndex >= 0 ? requestedIndex : 0;
    }

    int selected = -1;
    SIZE_T selectedMemory = 0;
    IDXGIAdapter1* adapter = nullptr;
    for (UINT index = 0; factory->EnumAdapters1(index, &adapter) != DXGI_ERROR_NOT_FOUND; ++index)
    {
        DXGI_ADAPTER_DESC1 description{};
        adapter->GetDesc1(&description);
        adapter->Release();
        const bool isSoftware = (description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0;
        std::wcout << L"  GPU " << index << L": " << description.Description << L" ("
                   << description.DedicatedVideoMemory / (1024 * 1024) << L" MB)" << (isSoftware ? L" [Software]" : L"")
                   << L'\n';
        if (requestedIndex < 0 && !isSoftware && (selected < 0 || description.DedicatedVideoMemory > selectedMemory))
        {
            selected = static_cast<int>(index);
            selectedMemory = description.DedicatedVideoMemory;
        }
    }
    factory->Release();

    if (requestedIndex >= 0)
    {
        selected = requestedIndex;
    }
    else if (selected < 0)
    {
        selected = 0;
    }
    std::cout << "DirectML verwendet GPU " << selected << " (andere mit --gpu <Nummer>).\n";
    return selected;
}

// Reports the achieved tracking rate; fast movements need the full 30 frames per second.
class TrackingRateMonitor
{
public:
    void Count(uint32_t bodies)
    {
        ++_frames;
        _bodies = bodies;
        const auto now = std::chrono::steady_clock::now();
        const auto elapsed = std::chrono::duration<double>(now - _start).count();
        if (elapsed >= 2.0)
        {
            std::cout << "Tracking: " << static_cast<int>(_frames / elapsed + 0.5) << " Bilder/s, Personen: " << _bodies
                      << (_frames / elapsed < 25.0 ? "  (unter 30 Bilder/s: schnelle Bewegungen werden ungenauer)" : "")
                      << '\n';
            _frames = 0;
            _start = now;
        }
    }

private:
    std::chrono::steady_clock::time_point _start = std::chrono::steady_clock::now();
    int _frames = 0;
    uint32_t _bodies = 0;
};

void RenderBodyFrame(k4abt_frame_t frame, Window3dWrapper& viewer)
{
    const k4a::capture capture(k4abt_frame_get_capture(frame));
    const auto depth = capture.get_depth_image();
    const k4a::image bodyMap(k4abt_frame_get_body_index_map(frame));
    if (!depth || !bodyMap)
    {
        throw std::runtime_error("Tracking result did not contain depth and body-index images.");
    }
    const auto width = depth.get_width_pixels();
    const auto height = depth.get_height_pixels();
    if (width != bodyMap.get_width_pixels() || height != bodyMap.get_height_pixels())
    {
        throw std::runtime_error("Tracking result did not contain matching depth and body-index images.");
    }

    constexpr Color background{ 1.f, 1.f, 1.f, 1.f };
    const auto bodyCount = k4abt_frame_get_num_bodies(frame);
    std::vector<Color> bodyColors(bodyCount);
    viewer.CleanJointsAndBones();
    for (uint32_t index = 0; index < bodyCount; ++index)
    {
        k4abt_body_t body{};
        body.id = k4abt_frame_get_body_id(frame, index);
        bodyColors[index] = g_bodyColors[body.id % g_bodyColors.size()];
        if (k4abt_frame_get_body_skeleton(frame, index, &body.skeleton) == K4A_RESULT_SUCCEEDED)
        {
            Color skeletonColor = bodyColors[index];
            skeletonColor.a = 0.4f;
            viewer.AddBody(body, skeletonColor);
        }
    }

    std::vector<Color> pointColors(static_cast<size_t>(width) * height, background);
    const auto stride = bodyMap.get_stride_bytes();
    for (int y = 0; y < height; ++y)
    {
        const auto* row = bodyMap.get_buffer() + static_cast<size_t>(y) * stride;
        auto* colors = pointColors.data() + static_cast<size_t>(y) * width;
        for (int x = 0; x < width; ++x)
        {
            const auto bodyIndex = row[x];
            if (bodyIndex != K4ABT_BODY_INDEX_MAP_BACKGROUND && bodyIndex < bodyColors.size())
            {
                colors[x] = bodyColors[bodyIndex];
            }
        }
    }
    viewer.UpdatePointClouds(depth.handle(), std::move(pointColors));
}

void RunViewer(k4abt_tracker_processing_mode_t processingMode, int gpuIndex, bool streamToDashboard, bool streamToAvatar)
{
    auto device = k4a::device::open(0);
    auto cameraConfig = K4A_DEVICE_CONFIG_INIT_DISABLE_ALL;
    cameraConfig.depth_mode = K4A_DEPTH_MODE_NFOV_UNBINNED;
    cameraConfig.camera_fps = K4A_FRAMES_PER_SECOND_30;
    if (streamToDashboard)
    {
        cameraConfig.color_format = K4A_IMAGE_FORMAT_COLOR_MJPG;
        cameraConfig.color_resolution = K4A_COLOR_RESOLUTION_720P;
        cameraConfig.synchronized_images_only = true;
    }
    device.start_cameras(&cameraConfig);
    auto calibration = device.get_calibration(cameraConfig.depth_mode, cameraConfig.color_resolution);

    ViewerState state;
    Window3dWrapper viewer;
    viewer.Create("PaceScapeBodyTrackingTest - Live 3D Body Tracking", calibration);
    viewer.SetCloseCallback(CloseViewer, &state);
    viewer.SetKeyCallback(HandleKey, &state);
    viewer.Render();

    auto trackerConfig = K4ABT_TRACKER_CONFIG_DEFAULT;
    trackerConfig.processing_mode = processingMode;
    if (processingMode == K4ABT_TRACKER_PROCESSING_MODE_GPU_DIRECTML)
    {
        trackerConfig.gpu_device_id = SelectDirectMlAdapter(gpuIndex);
    }
    k4abt_tracker_t trackerHandle = nullptr;
    if (k4abt_tracker_create(&calibration, trackerConfig, &trackerHandle) != K4A_RESULT_SUCCEEDED)
    {
        throw std::runtime_error("Body tracker initialization failed. Check the model and runtime files or try CPU mode.");
    }
    const std::unique_ptr<std::remove_pointer_t<k4abt_tracker_t>, decltype(&DestroyTracker)>
        tracker(trackerHandle, DestroyTracker);

    DashboardStream dashboard;
    std::unique_ptr<AvatarStream> avatar;
    if (streamToAvatar)
    {
        avatar = std::make_unique<AvatarStream>();
    }
    TrackingRateMonitor rate;
    while (state.running)
    {
        k4a::capture capture;
        if (device.get_capture(&capture, std::chrono::milliseconds(10)) &&
            k4abt_tracker_enqueue_capture(tracker.get(), capture.handle(), 0) == K4A_WAIT_RESULT_FAILED)
        {
            throw std::runtime_error("Could not queue a depth capture for tracking.");
        }

        k4abt_frame_t frameHandle = nullptr;
        const auto result = k4abt_tracker_pop_result(tracker.get(), &frameHandle, 0);
        if (result == K4A_WAIT_RESULT_FAILED)
        {
            throw std::runtime_error("Could not retrieve a tracking result.");
        }
        if (result == K4A_WAIT_RESULT_SUCCEEDED)
        {
            const std::unique_ptr<std::remove_pointer_t<k4abt_frame_t>, decltype(&k4abt_frame_release)>
                frame(frameHandle, k4abt_frame_release);
            rate.Count(k4abt_frame_get_num_bodies(frame.get()));
            RenderBodyFrame(frame.get(), viewer);
            if (streamToDashboard)
            {
                dashboard.Publish(frame.get(), calibration);
            }
            if (avatar)
            {
                avatar->Publish(frame.get());
            }
        }

        viewer.SetJointFrameVisualization(state.showJointAxes);
        viewer.Render();
    }
}
}

int main(int argc, char** argv)
{
    auto mode = K4ABT_TRACKER_PROCESSING_MODE_GPU_DIRECTML;
    bool modeSpecified = false;
    bool streamToDashboard = false;
    bool streamToAvatar = false;
    int gpuIndex = -1;
    for (int index = 1; index < argc; ++index)
    {
        const std::string_view option = argv[index];
        if (option == "--dashboard" && !streamToDashboard)
        {
            streamToDashboard = true;
        }
        else if (option == "--avatar" && !streamToAvatar)
        {
            streamToAvatar = true;
        }
        else if (option == "--gpu" && gpuIndex < 0 && index + 1 < argc)
        {
            const std::string_view value = argv[++index];
            if (value.empty() || value.size() > 2 || value.find_first_not_of("0123456789") != std::string_view::npos)
            {
                std::cerr << "--gpu erwartet eine GPU-Nummer (z. B. --gpu 1).\n";
                return 1;
            }
            gpuIndex = std::stoi(std::string(value));
        }
        else if (!modeSpecified && (option == "DirectML" || option == "CPU"))
        {
            mode = option == "CPU" ? K4ABT_TRACKER_PROCESSING_MODE_CPU : K4ABT_TRACKER_PROCESSING_MODE_GPU_DIRECTML;
            modeSpecified = true;
        }
        else
        {
            std::cerr << "Usage: PaceScapeBodyTrackingTest.exe [DirectML|CPU] [--gpu <Nummer>] [--dashboard] [--avatar]\n";
            return 1;
        }
    }

    try
    {
        RunViewer(mode, gpuIndex, streamToDashboard, streamToAvatar);
    }
    catch (const std::exception& error)
    {
        std::cerr << "PaceScapeBodyTrackingTest: " << error.what() << '\n';
        return 1;
    }
    return 0;
}
